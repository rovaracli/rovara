import { createElement as h } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../../../packages/ui/src/host.js";
import { ThemeProvider } from "../../../../packages/ui/src/theme.js";
import { accountSetupReadRoutes } from "../../../../packages/ui/src/routes/account-setup-read-routes.js";
import { AccountSetupReadEntry } from "./legacy/SetupEntry.js";
import { fakeHost } from "../../support/fake-host.js";
import { renderUi } from "../../support/render.js";
import { respond } from "./fixtures.js";

export function mount(path = "/app/account", reply: (r: ApiRequest) => ApiResponse | Promise<ApiResponse> = respond, slot?: "name" | "checklist") {
 const f = fakeHost(async r => reply(r));
 const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
 const router = createMemoryRouter([{ path: "/app", children: [...accountSetupReadRoutes(), { path: "onboard", element: h(AccountSetupReadEntry) }, { path: "projects/:name", element: h(AccountSetupReadEntry, { slot: "checklist" }) }, { path: "work", element: h(AccountSetupReadEntry, { slot: slot ?? "name" }) }] }], { initialEntries: [path] });
 const tree = h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) });
 const ui = renderUi(tree);
 return { ...f, query, router, close: () => { ui.unmount(); router.dispose(); query.clear(); } };
}
