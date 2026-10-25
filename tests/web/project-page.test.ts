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
function setup(value = projectFixture(), options: { theme?: "light" | "dark"; send?: (request: ApiRequest) => Promise<ApiResponse> } = {}) {
 let body: unknown = value, status = 200;
 const f = fakeHost(async request => request.method === "GET" ? { status, body } : options.send ? options.send(request) : { status: 202, body: { task: taskFixture({ sessionId: id }) } });
 const query = createQueryClient(), ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...f, ...ui, query, answer(next: unknown, code = 200) { body = next;status = code; }, close() { ui.unmount();query.clear(); } };
}
it("shows the actual project, workflows, budget, running work and exact visibility note", async () => {
 const f = setup();await screen.findByRole("heading", { name: "payments" });expect(screen.getByText("Keep customer payments dependable.")).toBeTruthy();expect(screen.getByText("acme/payments")).toBeTruthy();expect(screen.getByText("Setup ready")).toBeTruthy();expect(screen.getByText("Everyone on this project can see its sessions, including people who reach it through its Slack channel.")).toBeTruthy();expect(screen.getByText("$812.00")).toBeTruthy();expect(screen.getByText("$2,000.00")).toBeTruthy();expect(screen.getByText(/per merged pull request/u)).toBeTruthy();expect(screen.getByRole("heading", { name: "Fix duplicate refunds" })).toBeTruthy();expect(screen.getByRole("link", { name: "Payments expert" }).getAttribute("href")).toBe("/app/agents/agt_aaaaaaaaaaaaaaaaaaaa");f.close();
});
it("starts the selected shared agent once and opens the actual returned session", async () => {
 let finish: ((value: ApiResponse) => void) | undefined;
 const send = vi.fn(async () => new Promise<ApiResponse>(resolve => { finish = resolve; })), f = setup(undefined, { send }), navigate = vi.spyOn(f.host, "navigate");
 fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));const input = await screen.findByRole("textbox", { name: "What should Payments expert do?" });fireEvent.change(input, { target: { value: "Investigate the duplicate refund" } });const start = screen.getByRole("button", { name: "Start session" });fireEvent.click(start);fireEvent.click(start);expect(send).toHaveBeenCalledTimes(1);expect(navigate).not.toHaveBeenCalled();finish?.({ status: 202, body: { task: taskFixture({ sessionId: id }) } });await waitFor(() => expect(navigate).toHaveBeenCalledWith("/s/" + id));expect(f.request.mock.calls.find(([request]) => request.method === "POST")?.[0]).toMatchObject({ path: "/v1/app/agents/agt_aaaaaaaaaaaaaaaaaaaa/runs", body: { project: "payments", input: { text: "Investigate the duplicate refund" }, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown } });f.close();
});
it("keeps the excluded Rovara Code start unavailable without posting a guessed endpoint", async () => {
 const f = setup();fireEvent.click(await screen.findByRole("button", { name: "New session" }));expect(screen.queryByRole("button", { name: "Rovara Code" })).toBeNull();expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);f.close();
});
it("does not offer New session, settings or spend without their server capabilities", async () => {
 const f = setup(projectFixture({ you: { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false }, project: { ...projectFixture().project, setup: { status: "failed", failedStep: "bootstrap" } } }));await screen.findByRole("heading", { name: "payments" });expect(screen.queryByRole("button", { name: "New session" })).toBeNull();expect(screen.queryByRole("link", { name: "Setup needs attention" })).toBeNull();expect(screen.getByText("Setup needs attention")).toBeTruthy();expect(screen.queryByText("$812.00")).toBeNull();f.close();
});
it("links a permitted setup repair to onboarding's Setup step", async () => {
 const value = projectFixture();value.project.setup.status = "failed";const f = setup(value);expect((await screen.findByRole("link", { name: "Setup needs attention" })).getAttribute("href")).toBe("/app/onboard?project=payments&step=setup");f.close();
});
it("shows a budget refusal in the start dialog without claiming work started", async () => {
 const f = setup(undefined, { send: async () => ({ status: 403, body: { error: { code: "BUDGET_EXHAUSTED", message: "The project has reached its monthly budget." } } }) });fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));fireEvent.change(await screen.findByRole("textbox", { name: "What should Payments expert do?" }), { target: { value: "Investigate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));expect(await screen.findByText("The project has reached its monthly budget.")).toBeTruthy();expect(screen.getByRole("dialog")).toBeTruthy();f.close();
});
it("requires a nonblank problem and enforces the 4000-character limit", async () => {
 const f = setup();fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));const input = await screen.findByRole("textbox", { name: "What should Payments expert do?" }), start = screen.getByRole<HTMLButtonElement>("button", { name: "Start session" });expect(start.disabled).toBe(true);fireEvent.change(input, { target: { value: " ".repeat(4) } });expect(start.disabled).toBe(true);fireEvent.change(input, { target: { value: "x".repeat(4001) } });expect(start.disabled).toBe(true);expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);f.close();
});
it("does not make up a session id or allow a duplicate start when a legacy answer lacks its link", async () => {
 const f = setup(undefined, { send: async () => ({ status: 202, body: { task: taskFixture() } }) });fireEvent.click(await screen.findByRole("button", { name: "New session" }));fireEvent.click(screen.getByRole("button", { name: "Payments expert" }));fireEvent.change(await screen.findByRole("textbox", { name: "What should Payments expert do?" }), { target: { value: "Investigate refunds" } });fireEvent.click(screen.getByRole("button", { name: "Start session" }));expect(await screen.findByRole("link", { name: "Open Live" })).toBeTruthy();expect(screen.getByRole<HTMLButtonElement>("button", { name: "Start session" }).disabled).toBe(true);f.close();
});
it("does not display cached project details or controls after access is refused", async () => {
 const f = setup();await screen.findByRole("heading", { name: "payments" });f.answer({ error: { code: "PROJECT_NOT_FOUND", message: "Not found." } }, 404);await f.query.invalidateQueries({ queryKey: ["project", "payments", "overview"] });await screen.findByRole("heading", { name: "This page isn't available" });expect(screen.queryByRole("button", { name: "New session" })).toBeNull();expect(screen.queryByText("Keep customer payments dependable.")).toBeNull();f.close();
});
it("validates start identities and refuses the excluded code route before transport", async () => {
 const f = fakeHost(), api = createRunApi(f.host);await expect(async () => api.startWork("rovara-code", { project: "payments", text: "Fix it" })).rejects.toThrow();await expect(async () => api.startWork("../outside", { project: "payments", text: "Fix it" })).rejects.toThrow();expect(f.request).not.toHaveBeenCalled();
});
for (const theme of ["light", "dark"] as const) it("has an accessible project overview in " + theme, async () => { const f = setup(undefined, { theme });await screen.findByRole("heading", { name: "payments" });await expectNoAxeViolations(f.container);f.close(); });
