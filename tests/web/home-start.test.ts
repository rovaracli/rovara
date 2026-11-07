// @vitest-environment jsdom
// UX2 slice 2 item 7: a task can be started from Home too. The person's projects come from the sidebar's data (never fetched here); the project's own start box shows only where the project page would
// show it (`canStartWork`), and a person who can't start work is told so instead.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { HomeStart } from "../../packages/ui/src/screens/home/HomeStart.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";

function setup(projects: string[], canStart: Record<string, boolean>) {
 const f = fakeHost(async request => {
  const match = /^\/v1\/app\/projects\/([^/]+)\/overview$/u.exec(request.path);
  if (match !== null) { const name = decodeURIComponent(match[1]!);const base = projectFixture();return { status: 200, body: { ...base, project: { ...base.project, name }, you: { ...base.you, canStartWork: canStart[name] === true } } }; }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 });
 const query = createQueryClient();
 query.setQueryData(["nav"], { projects: projects.map(name => ({ name, agents: [] })) });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(HomeStart, {}) }) }) }));
 return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}

it("shows the project's start box on Home for a person who may start work there", async () => {
 const f = setup(["web"], { web: true });
 expect(await screen.findByLabelText("What do you need?")).toBeTruthy();
 expect(f.container.textContent).toContain("Project: web");
 f.close();
});

it("lets a person with several projects pick one, and says so where they can't start work", async () => {
 const f = setup(["api", "web"], { web: true });
 expect(await screen.findByText("You can't start work in this project. Ask one of its maintainers.")).toBeTruthy();
 expect(screen.queryByLabelText("What do you need?")).toBeNull();
 fireEvent.change(screen.getByLabelText("Project"), { target: { value: "web" } });
 await waitFor(() => expect(screen.getByLabelText("What do you need?")).toBeTruthy());
 f.close();
});

it("shows nothing to a person with no projects", () => {
 const f = setup([], {});
 expect(f.container.textContent).toBe("");
 f.close();
});
