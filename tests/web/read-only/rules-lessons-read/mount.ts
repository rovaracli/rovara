import { createQueryClient } from "../../../../packages/ui/src/api/query.js";
import { h } from "../../support/h.js";
import { renderUi } from "../../support/render.js";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppHostProvider } from "../../../../packages/ui/src/host.js";
import { useParams } from "react-router";
import ProjectHowWeWorkPage, { CompanyRulesPage, SetupRecipesPage } from "../../../../packages/ui/src/screens/rules-lessons-read/LazyPages.js";
import { fakeHost } from "../../support/fake-host.js";
import { responder } from "./fixtures.js";
// The live tools inside the views (checkboxes, tabs) measure with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
/** The project tab entry as ProjectScreen mounts it (the name is the route param). */
function ProjectTab() { const { name } = useParams();return h(ProjectHowWeWorkPage, { project: name ?? "" }); }
export function mount(path = "/app/projects/payments?tab=how-we-work", answer = responder()) {
 const cell = fakeHost(answer), query = createQueryClient();
 query.setDefaultOptions({ queries: { retry: false, gcTime: 0, staleTime: 0 } });
 const router = createMemoryRouter([{ path: "/app/admin/how-we-work", element: h(CompanyRulesPage) }, { path: "/app/admin/how-we-work/recipes", element: h(SetupRecipesPage) }, { path: "/app/projects/:name", element: h(ProjectTab) }], { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query }, h(RouterProvider, { router })) }));
 return { ...cell, ...view, query, router };
}
