// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

// The owner-only Company domains page: the record to publish, check now, remove after confirming, and a fresh sign-in asked for in words.

const PATH = "/v1/app/org/domains";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const TOKEN = "c".repeat(40);
const when = "2026-11-02T09:00:00.000Z";
const view = (overrides: Record<string, unknown> = {}) => ({
 domain: "acme.example", state: "pending", addedAt: when,
 record: { type: "TXT", name: "_rovara-verify.acme.example", value: `rovara-verify=${TOKEN}` }, ...overrides,
});
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;

function mount(options: { role?: "owner" | "admin"; domains?: Array<Record<string, unknown>>; post?: Handler } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let domains = options.domains ?? [];
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === PATH && request.method === "GET") return { status: 200, body: { domains, max: 20, lostAfterDays: 3 } };
  if (path?.startsWith(PATH) && request.method === "POST") {
   const custom = await options.post?.(request);
   if (custom !== undefined) return custom;
   const body = request.body as { domain: string };
   if (path === PATH) { const added = view({ domain: body.domain }); domains = [...domains, added]; return { status: 200, body: { domain: added } }; }
   if (path === `${PATH}/check`) { const found = domains.find(entry => entry.domain === body.domain)!; return { status: 200, body: { domain: found, result: "not_found" } }; }
   if (path === `${PATH}/remove`) { domains = domains.filter(entry => entry.domain !== body.domain); return { status: 200, body: { removed: true } }; }
  }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/domains"] });
 const view_ = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 const calls = () => f.request.mock.calls.map(([request]) => request);
 return { ...f, ...view_, posts: () => calls().filter(request => request.method === "POST"), reads: () => calls().filter(request => request.method === "GET" && request.path === PATH) };
}
afterEach(() => { document.body.innerHTML = ""; });

describe("the Company domains page (hidden: the hosted Code does not serve it, DEC 254zzz113/115/116)", () => {
 for (const role of ["owner", "admin"] as const) it(`has no page and no navigation link for a ${role}, and sends nothing to the domains route`, async () => {
  const f = mount({ role, domains: [view()] });
  await screen.findByRole("navigation", { name: "Administration" });
  expect(screen.queryByRole("heading", { name: "Company domains" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Company domains" })).toBeNull();
  expect(screen.queryByRole("button", { name: /check now|remove|add/i })).toBeNull();
  expect(f.request.mock.calls.some(([request]) => request.path.startsWith(PATH))).toBe(false);
 });
});
