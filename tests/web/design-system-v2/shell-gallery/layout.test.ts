// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../../../packages/ui/src/host.js";
import { ThemeProvider } from "../../../../packages/ui/src/theme.js";
import { createQueryClient } from "../../../../packages/ui/src/api/query.js";
import { fakeHost } from "../../support/fake-host.js";
import { renderUi } from "../../support/render.js";
import { h } from "../../support/h.js";
async function scene(id: string) {
 const nav = AppNavReaderSchema.parse({ me: { developerId: "a".repeat(64), name: "Ana", orgRole: "member" }, org: { name: "Acme" }, homeCount: 3, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false } });
 const f = fakeHost(async () => ({ status: 200, body: nav })), query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [`/app/design-system?scene=${id}`] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 await screen.findByRole("heading", { level: 1, name: "A calm control room" });
 return { ...ui, close: () => { ui.unmount();router.dispose();query.clear(); } };
}
it("keeps the real, role-filtered sidebar beside shell captures while giving the sheet full width", async () => {
 const shell = await scene("shell-running");
 try { expect(shell.container.querySelector(".rv-app-shell")?.classList.contains("rv-shell-sheet")).toBe(true);expect(screen.getByRole("navigation", { name: "Example workspace" })).toBeTruthy(); } finally { shell.close(); }
 const sheet = await scene("colours");try { expect(sheet.container.querySelector(".rv-app-shell")?.classList.contains("rv-shell-sheet")).toBe(true); } finally { sheet.close(); }
});
it("draws the loading placeholder in the shape of four final task rows", async () => {
 const f = await scene("states-loading");
 try { expect(screen.getByRole("progressbar", { name: "Loading task rows" }).querySelectorAll("li")).toHaveLength(4);expect(screen.queryByText("No tasks yet")).toBeNull(); } finally { f.close(); }
});
