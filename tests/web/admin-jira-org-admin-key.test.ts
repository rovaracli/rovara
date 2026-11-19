// @vitest-environment jsdom
// The Jira organization admin key form is hidden on the Connections page: the hosted Code does not serve it (DEC 254zzz113/115/116).
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const JIRA = "con_bbbbbbbbbbbbbbbbbbbb";
const row = (connectionId: string, type: string, label: string) => ({ connectionId, type, label, identity: "service", hasCredential: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", lastCheck: { ok: true, at: "2026-10-02T00:00:00Z" } });
function mount(options: { role?: "owner" | "admin" | "member"; connections?: unknown[]; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined> } = {}) {
  const role = options.role ?? "owner";
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const connections = options.connections ?? [row("con_aaaaaaaaaaaaaaaaaaaa", "linear", "Tracker"), row(JIRA, "jira", "Company Jira")];
  const f = fakeHost(async request => (await options.respond?.(request)) ?? { status: 200, body: request.path === "/v1/app/nav" ? nav : request.path === "/v1/app/me" ? me : request.path === "/v1/app/connections" ? { connections } : request.path === "/v1/app/github/installations" ? { installations: [] } : request.path === "/v1/app/github/requests" ? { requests: [] } : {} });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/connections"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, close: () => { view.unmount();router.dispose();query.clear(); } };
}

for (const role of ["owner", "admin"] as const) it(`shows a ${role} with a Jira connection the connection, but no organization admin key form, and sends nothing to its route`, async () => {
  const f = mount({ role });
  await screen.findByText("Company Jira");
  expect(screen.queryByRole("heading", { name: "Jira organization admin key" })).toBeNull();
  expect(screen.queryByLabelText("Organization admin API key")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save key" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path.includes("jira-org-admin"))).toBe(false);
  f.close();
});
