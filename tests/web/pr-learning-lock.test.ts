// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture } from "./support/fixtures.js";

const GUARDRAILS = "/v1/app/org/agent-guardrails";
const base = { maxAutonomy: "prepare", forbiddenModels: [], requireCrossCompanyReview: true, maxAgentMonthlyUsd: 100, maxPerRunCeilingUsd: 10, disabledBuiltins: [], extraTriggerLabels: [], extraCommandWords: [], reportLinkDomains: [] };
const agent = { agentId: "rovara-code", name: "Rovara Code", description: "Build code", builtin: true, status: "active", access: "edit", latestVersion: 2, pinnedVersion: 1, monthlyBudgetUsd: 0 };
type Doc = { guardrails: Record<string, unknown>; revision: number };
function mount(options: { doc?: Doc; role?: string; put?: (request: ApiRequest) => ApiResponse | Promise<ApiResponse> } = {}) {
 const state = { doc: options.doc ?? { guardrails: base, revision: 7 } };
 const me = meFixture();me.developer.orgRole = (options.role ?? "owner") as typeof me.developer.orgRole;
 const nav = navFixture({ me: { developerId: me.developer.id, name: "Priya", orgRole: options.role === "member" ? "member" : "owner" }, features: { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false } });
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: structuredClone(me) };
  if (request.path === "/v1/app/nav") return { status: 200, body: nav };
  if (request.path === GUARDRAILS && request.method === "PUT") return options.put?.(request) ?? { status: 200, body: state.doc };
  if (request.path === GUARDRAILS) return { status: 200, body: structuredClone(state.doc) };
  return { status: 200, body: { agents: [agent] } };
 });
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const routes = appRoutes(nav.features), admin = routes.find(r => r.path === "/app")!.children!.find(r => r.path === "admin/*")!;
 admin.children!.unshift({ path: "agents", lazy: async () => ({ Component: (await import("../../packages/ui/src/screens/admin/agents/AgentsScreen.js")).AgentsScreen }) });
 const router = createMemoryRouter(routes, { initialEntries: ["/app/admin/agents"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const puts = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method === "PUT");
 return { ...f, ...view, state, puts, close() { view.unmount();router.dispose();query.clear(); } };
}
const row = () => screen.findByText(/^Learning from PR review comments:/u);
afterEach(() => { document.body.innerHTML = ""; });

describe("the company lock for learning from PR review comments", () => {
 it("shows Allowed when the setting is absent, with a Lock off button", async () => {
  const f = mount();
  expect((await row()).textContent).toBe("Learning from PR review comments: Allowed");
  expect(screen.getByRole("button", { name: "Lock off" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Allow again" })).toBeNull();
  f.close();
 });
 it("shows Locked off with Allow again", async () => {
  const f = mount({ doc: { guardrails: { ...base, prCommentLearning: "locked_off" }, revision: 7 } });
  expect((await row()).textContent).toBe("Learning from PR review comments: Locked off");
  expect(screen.getByRole("button", { name: "Allow again" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Lock off" })).toBeNull();
  f.close();
 });
 it("Lock off sends the whole document as read, with only that field changed and an unknown extra field kept", async () => {
  const f = mount({ doc: { guardrails: { ...base, someFutureField: { keep: ["me"] } }, revision: 7 } });
  await row();
  fireEvent.click(screen.getByRole("button", { name: "Lock off" }));
  await waitFor(() => expect(f.puts()).toHaveLength(1));
  const put = f.puts()[0]!, body = put.body as { requestId: string; expectedRevision: number; guardrails: Record<string, unknown> };
  expect(put.path).toBe(GUARDRAILS);
  expect(body.expectedRevision).toBe(7);
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(body.guardrails).toEqual({ ...base, someFutureField: { keep: ["me"] }, prCommentLearning: "locked_off" });
  f.close();
 });
 it("Allow again sends allowed and reads again on 200", async () => {
  const f = mount({ doc: { guardrails: { ...base, prCommentLearning: "locked_off" }, revision: 7 }, put: () => { f.state.doc = { guardrails: { ...base, prCommentLearning: "allowed" }, revision: 8 };return { status: 200, body: f.state.doc }; } });
  await row();
  fireEvent.click(screen.getByRole("button", { name: "Allow again" }));
  await waitFor(() => expect(screen.getByText("Learning from PR review comments: Allowed")).toBeTruthy());
  expect((f.puts()[0]!.body as { guardrails: Record<string, unknown> }).guardrails).toEqual({ ...base, prCommentLearning: "allowed" });
  expect(await screen.findByText("Guardrail revision: 8")).toBeTruthy();
  f.close();
 });
 it("a 202 shows that a company admin must approve, with the server's words", async () => {
  const f = mount({ doc: { guardrails: { ...base, prCommentLearning: "locked_off" }, revision: 7 }, put: () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: "https://cell.example/v1/app/approve/abc123", changes: ["Allow learning from PR review comments again"] } }) });
  await row();
  fireEvent.click(screen.getByRole("button", { name: "Allow again" }));
  await screen.findByText("Waiting for a company admin to approve");
  expect(screen.getByText("Allow learning from PR review comments again")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open confirmation" })).toBeTruthy();
  f.close();
 });
 it("shows a refusal as plain text", async () => {
  const message = "Someone else changed the guardrails <img src=x onerror=alert(1)>";
  const f = mount({ put: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message } } }) });
  await row();
  fireEvent.click(screen.getByRole("button", { name: "Lock off" }));
  const alert = await screen.findByText(message);
  expect(alert.querySelector("img")).toBeNull();
  f.close();
 });
 it("a double click sends one request", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = mount({ put: async () => { await gate;return { status: 200, body: f.state.doc }; } });
  await row();
  const lock = screen.getByRole<HTMLButtonElement>("button", { name: "Lock off" });
  fireEvent.click(lock);fireEvent.click(lock);
  release();
  await waitFor(() => expect(f.puts()).toHaveLength(1));
  f.close();
 });
});
