// @vitest-environment jsdom
// Lane team-record-links: the admin page for Linear and Jira people the automatic linker could not match.
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
const SAM = "b".repeat(64), PRIYA = "c".repeat(64);
const members = [{ developerId: SAM, name: "Sam Kerr", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" }, { developerId: PRIYA, name: "Priya Rao", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" }];
const people = {
  unmatched: [{ tool: "Linear", system: "linear", sourceId: "lin-sam", displayName: "Sam K", reason: "no_verified_domains" }, { tool: "Jira", system: "jira:acme.atlassian.net", sourceId: "acc-9", displayName: "Nine <b>bold</b>" }],
  linked: [{ tool: "Linear", system: "linear", sourceId: "lin-priya", displayName: "Priya R", developerId: PRIYA, via: "admin" }, { tool: "Linear", system: "linear", sourceId: "lin-auto", displayName: "Auto A", developerId: SAM, via: "auto", why: "domain_company_account_exact_email" }],
  truncated: false,
  autoLink: { enabled: false, verifiedDomainsRecorded: false },
};
function mount(options: { role?: "owner" | "admin" | "member"; respond?: (request: ApiRequest) => Promise<ApiResponse | undefined> } = {}) {
  const role = options.role ?? "owner";
  const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Omar", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
  const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Omar", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
  const f = fakeHost(async request => (await options.respond?.(request)) ?? { status: 200, body: request.path === "/v1/app/nav" ? nav : request.path === "/v1/app/me" ? me : request.path === "/v1/app/org/tracker-people" ? people : request.path === "/v1/app/org/members" ? { members } : {} });
  f.host.kind = "web";
  f.host.viewport = { width: () => 1280, subscribe: () => () => undefined };
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/tracker-people"] });
  const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
  return { ...f, ...view, close: () => { view.unmount();router.dispose();query.clear(); } };
}

// The Tracker people page is hidden: the hosted Code does not serve it (DEC 254zzz113/115/116).
for (const role of ["owner", "admin"] as const) it(`has no Tracker people page and no navigation link for a ${role}, and sends nothing to its route`, async () => {
  const f = mount({ role });
  await screen.findByRole("navigation", { name: "Administration" });
  expect(screen.queryByRole("heading", { name: "Tracker people" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Tracker people" })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path.includes("tracker-people"))).toBe(false);
  f.close();
});
