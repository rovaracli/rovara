// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { howWeWorkHost } from "./support/how-we-work-fixture.js";

it("keeps hosted How we work read-only and links to the repository playbook file", async () => {
 const cell = howWeWorkHost(), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: "light" });
 await screen.findByRole("heading", { name: "Build" });
 const link = screen.getByRole("link", { name: "edit .rovara/playbook.yaml in your repo" });
 expect(link.getAttribute("href")).toContain("github.com");expect(link.getAttribute("href")).toContain(".rovara/playbook.yaml");
 expect(screen.queryByRole("button", { name: /save|publish|review changes|remove/i })).toBeNull();
 expect(screen.queryByRole("textbox", { name: /project rules|instructions/i })).toBeNull();
 expect(cell.calls()).toContain("GET /v1/app/projects/payments/how-we-work");
 await expectNoAxeViolations(ui.container);
 ui.unmount();query.clear();
});
