// @vitest-environment jsdom
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
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
it("shows only known-failing policy and leaves model defaults in the consolidated card", async () => {
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async request => request.path === "/v1/app/nav" ? { status: 200, body: nav } : request.path === "/v1/app/me" ? { status: 200, body: me } : request.path === "/v1/app/org/known-failing-policy" ? { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
 f.host.kind = "web";f.host.origin = "https://cell.example";
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/how-we-work"] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: "light" });
 await screen.findByRole("heading", { name: "How we work (company)" });
 expect(screen.queryByRole("region", { name: "Build" })).toBeNull();
 expect(screen.queryByRole("region", { name: "Plan check" })).toBeNull();
 // The known-failing explanation is fixed text now (one maintainer, no configurable approval count; owner DEC 254zzz133).
 const kf = screen.getByRole("region", { name: "Marking tests as already failing" });
 expect(kf.textContent).toContain("One currently authorized project maintainer");
 expect(kf.textContent).not.toMatch(/two people|signed in within/iu);
 expect(kf.querySelector("button")).toBeNull();
 expect(screen.getByRole("link", { name: "Back to AI models" }).getAttribute("href")).toBe("/app/admin/ai-spending#ai-models");
 expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/model-selection-policy")).toBe(false);
 await expectNoAxeViolations(ui.container);
 ui.unmount();router.dispose();query.clear();
});
