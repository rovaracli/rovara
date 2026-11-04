import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { ProjectScreen } from "../../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { Announcer } from "../../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { renderUi } from "./render.js";
import { h } from "./h.js";
import { sourcesWorld } from "./sources-fixture.js";

/** The project page on its Sources tab, in a cell that answers the lessons routes and the record's sources route. */
export function openSources(options: Parameters<typeof sourcesWorld>[0] = {}, theme: "light" | "dark" = "light") {
 const cell = sourcesWorld(options), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=sources"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme });
 return { ...cell, ...ui, query };
}
