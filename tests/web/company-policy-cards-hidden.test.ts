// @vitest-environment jsdom
// DEC 254zzz113/115/116: the hosted Code serves none of the company policy cards except the known-failing policy, so the company How we work page shows only that card
// (model defaults live under Agent models) and sends no request for any hidden card. A route this page does not serve must never be reached by a button.
import { afterEach, expect, it } from "vitest";
import { cleanup, act, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const HIDDEN_PATHS = ["/org/design-review", "/org/learning-settings", "/org/setup-recipes", "/org/setup-agent/locks", "/org/agent-guardrails", "/org/model-selection-policy", "/org/task-stop-policy"];
afterEach(() => { cleanup(); });

function mount(role: "owner" | "admin") {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async request => {
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === "/v1/app/org/known-failing-policy") return { status: 200, body: { alwaysTwoPeople: false, pendingLoosening: false } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view };
}

for (const role of ["owner", "admin"] as const) it(`shows a company ${role} only the known-failing card: no hidden policy card, no button for one, no request for one`, async () => {
 const f = mount(role);
 await screen.findByRole("heading", { name: "Rules" });
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
 expect(await screen.findByRole("heading", { name: "Known failing tests" })).toBeTruthy();
 for (const name of ["Design review", "Setup locks", "Setup recipes", "Company model defaults"]) expect(screen.queryByRole("region", { name })).toBeNull();
 expect(screen.queryByText(/Rule suggestions/)).toBeNull();
 expect(screen.queryByText(/Learning from PR review comments/)).toBeNull();
 expect(screen.queryByRole("link", { name: "Open setup recipes" })).toBeNull();
 expect(screen.queryByRole("button", { name: /save|turn on|lock off|allow design review|approve/i })).toBeNull();
 const asked = f.request.mock.calls.map(([request]) => request.path.split("?")[0]!);
 for (const hidden of HIDDEN_PATHS) expect({ hidden, asked: asked.some(path => path.endsWith(hidden)) }).toEqual({ hidden, asked: false });
 await expectNoAxeViolations(f.container);
});
