import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../../../packages/ui/src/host.js";
import { WikiSkillsReadEntry } from "../../../../packages/ui/src/screens/wiki-skills-read/ReadEntry.js";
import { createQueryClient } from "../../../../packages/ui/src/api/query.js";
import { fixtureHost, reply } from "./fixtures.js";
/** Isolated host for these tests: the real mount is ProjectScreen (?tab=wiki / ?tab=skills), covered by tests/web/g3-wiki-skills-mount.test.ts. */
const wikiSkillsReadRoutes = (slot: "project" | "setup" | "answer" = "project") => [{ path: "/app/projects/:name", element: h(WikiSkillsReadEntry, { slot }) }];
export function mount(path = "/app/projects/web?tab=wiki", respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse> = reply, client = createQueryClient(), slot: "project" | "setup" | "answer" = "project") {
 client.setDefaultOptions({ queries: { retry: false, gcTime: Infinity, staleTime: 0 } });
 const fixture = fixtureHost(respond), router = createMemoryRouter(wikiSkillsReadRoutes(slot), { initialEntries: [path] });
 const render = () => renderUi(h(AppHostProvider, { host: fixture.host, children: h(QueryClientProvider, { client, children: h(RouterProvider, { router }) }) }));
 const ui = render();
 return { ...fixture, ...ui, client, router, reopen: render, close() { ui.unmount(); client.clear(); } };
}
