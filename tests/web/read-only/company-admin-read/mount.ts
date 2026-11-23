import { createElement as h } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../../../packages/ui/src/host.js";
import { ThemeProvider } from "../../../../packages/ui/src/theme.js";
import { createQueryClient } from "../../../../packages/ui/src/api/query.js";
import { appRoutes } from "../../../../packages/ui/src/routes.js";
import { fakeHost } from "../../support/fake-host.js";
import { renderUi } from "../../support/render.js";
import { identity, reply } from "./fixtures.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
/** G1 SHIP: the REAL production router (appRoutes + the shell + AdminLayout), never the page alone. The identity AdminLayout reads is whatever `respond` answers at /v1/app/me. */
export async function mount(path = "/app/admin", respond: (request: ApiRequest) => ApiResponse | Promise<ApiResponse> = reply, query = createQueryClient()) {
 const nav = AppNavSchema.parse({ me: { developerId: identity.developer.id, name: identity.developer.name, orgRole: identity.developer.orgRole }, org: { name: identity.org.name }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : respond(r)));
 query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query }, h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) })) }));
 return { ...f, ...view, query, router, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
