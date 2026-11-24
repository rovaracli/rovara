// @vitest-environment jsdom
// SU-1: the company How we work page's "Setup locks" (an admin's: off switch, caps, a loosening waiting for a different admin
// and when it expires, Approve with "Sign in again" on REAUTH_REQUIRED, Repair for an unreadable row). Nothing shows while the setup agent is off (not found). Every word that comes from the server goes through VisibleText.
import { describe, expect, it } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { companyPolicyRaw } from "./support/company-policy-raw.js";

const LOCKS_PATH = "/v1/app/org/setup-agent/locks";
const DEFAULTS = { commands: 40, sameStepTries: 3, wallClockMin: 45, budgetCents: 400, hostAsks: 5 };
const MAXIMA = { commands: 120, sameStepTries: 5, wallClockMin: 120, budgetCents: 2000, hostAsks: 10 };
const refuse = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;

// ---- the company page

const locksView = (over: Record<string, unknown> = {}) => ({ revision: 3, limits: {}, setupAgentOff: false, devcontainerImages: null, noSoleOwnerException: false, defaults: DEFAULTS, maxima: MAXIMA, ...over });
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };

function mountCompany(options: { view?: unknown; missing?: boolean; unavailable?: boolean; role?: "owner" | "admin" | "member"; write?: Handler } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 let view: unknown = options.view ?? locksView();
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0] ?? "";
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/model-selection-policy") return { status: 200, body: companyPolicyRaw() };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  if (path === "/v1/app/org/learning-settings") return refuse(404, "NOT_FOUND", "Not found.");
  if (path === LOCKS_PATH && options.missing === true) return refuse(404, "NOT_FOUND", "Not found.");
  if (path === LOCKS_PATH && request.method === "GET") return { status: 200, body: view };
  if (path.startsWith(LOCKS_PATH) && request.method !== "GET") {
   const custom = await options.write?.(request);
   if (custom !== undefined) return custom;
   return { status: 200, body: { status: "applied" } };
  }
  return refuse(404, "NOT_FOUND", "Not found.");
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: "light" });
 const writes = () => f.request.mock.calls.map(([request]) => request).filter(request => request.path.startsWith(LOCKS_PATH) && request.method !== "GET");
 return { ...f, ...ui, writes, set(next: unknown) { view = next; } };
}
describe("the company's Setup locks (hidden: the hosted Code does not serve them, DEC 254zzz113/115/116)", () => {
 it("shows no Setup locks card on the company How we work page, for an owner or an admin, and never asks for the locks", async () => {
  for (const role of ["owner", "admin"] as const) {
   const f = mountCompany({ role });
   await screen.findByRole("heading", { name: "Rules" });
   await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
   expect(screen.queryByRole("region", { name: "Setup locks" })).toBeNull();
   expect(f.request.mock.calls.some(([request]) => request.path.startsWith(LOCKS_PATH))).toBe(false);
   cleanup();
  }
 });
});
