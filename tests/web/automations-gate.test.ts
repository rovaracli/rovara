// @vitest-environment jsdom
// exp/automations: the one gate. Off (the nav answer's features.chains is not true) the app is exactly as before: chain and trigger addresses say "This isn't available", the project page has no Automations tab, and no
// automations request is made. On, a chain has its page and the project page has the tab.
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Route, Routes, RouterProvider, type RouteObject } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { navFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { CHAIN_ID, DESIGN, chainOf, draft, error, projectAutomations, runList, shares, versions } from "./support/automations-fixture.js";

globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const nav = (chains: boolean) => navFixture({ features: { admin: false, localAgents: false, usage: false, chains, describe: false, notices: false } });
afterEach(() => { vi.restoreAllMocks(); });

function answer(request: ApiRequest): ApiResponse {
  const base = "/v1/app/chains/" + CHAIN_ID;
  if (request.path === "/v1/app/changes") return { status: 200, body: { notices: [], next: "settled" } };
  if (request.path === "/v1/app/projects/payments/overview") return { status: 200, body: projectFixture() };
  if (request.path === "/v1/app/projects/payments/automations") return { status: 200, body: projectAutomations() };
  if (request.path === base) return { status: 200, body: { chain: chainOf(), current: { version: 2, definition: DESIGN } } };
  if (request.path === base + "/versions") return { status: 200, body: versions() };
  if (request.path === base + "/draft") return { status: 200, body: draft() };
  if (request.path === base + "/shares") return { status: 200, body: shares() };
  if (request.path === base + "/triggers") return { status: 200, body: { triggers: [] } };
  if (request.path.startsWith("/v1/app/chain-runs")) return { status: 200, body: runList() };
  if (request.path.endsWith("/start-preview")) return { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } };
  return { status: 404, body: error("NOT_FOUND", "Not found.") };
}
/** The /app children of the real route table (without the shell, which needs the whole navigation), at an address. */
function atRoute(chains: boolean, path: string) {
  const app = appRoutes(nav(chains).features).find(route => route.path === "/app")!, children: RouteObject[] = app.children!;
  const f = fakeHost(async request => answer(request)), query = createQueryClient(), router = createMemoryRouter([{ path: "/app", children }], { initialEntries: [path] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }));
  return { ...f, close() { ui.unmount();router.dispose();query.clear(); } };
}

it("off: a chain address and a trigger address say \"This isn't available\" and make no request", async () => {
  for (const path of ["/app/chains/" + CHAIN_ID, "/app/chains/x/y", "/app/triggers/ctr_" + "a".repeat(20)]) {
    const f = atRoute(false, path);
    expect(await screen.findByRole("heading", { name: "This isn't available", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/app");
    expect(f.request).not.toHaveBeenCalled();
    f.close();
  }
});

it("on: a chain address shows the chain's page (positive control), and an address that is not a chain is not found", async () => {
  const f = atRoute(true, "/app/chains/" + CHAIN_ID);
  expect(await screen.findByRole("heading", { name: "Refund triage", level: 1 })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "This isn't available" })).toBeNull();
  f.close();
  for (const path of ["/app/chains", "/app/triggers/ctr_" + "a".repeat(20)]) {
    const g = atRoute(true, path);
    expect(await screen.findByRole("heading", { name: /not found/i })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This isn't available" })).toBeNull();
    g.close();
  }
});

function projectPage(chains: boolean | undefined, tab = "") {
  const f = fakeHost(async request => answer(request)), query = createQueryClient();
  if (chains !== undefined) query.setQueryData(["nav"], nav(chains));
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments" + tab], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }));
  return { ...f, close() { ui.unmount();query.clear(); } };
}
const asked = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.some(call => call[0].path.includes("/automations") || call[0].path.includes("/chain-runs"));

it("off, or with no navigation answer: the project page has no Automations tab, even by address, and asks nothing about automations", async () => {
  for (const chains of [false, undefined]) {
    const f = projectPage(chains, "?tab=automations");
    await screen.findByRole("heading", { name: "payments" });
    expect(screen.queryByRole("tab", { name: "Automations" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Sources" })).toBeTruthy();
    expect(asked(f)).toBe(false);
    f.close();
  }
});

it("on: the project page has an Automations tab that loads the project's automations only when it is opened", async () => {
  const f = projectPage(true);
  await screen.findByRole("heading", { name: "payments" });
  expect(asked(f)).toBe(false);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Automations" }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name: "Automations" }));
  expect(await screen.findByRole("heading", { name: "Triggers" })).toBeTruthy();
  await waitFor(() => expect(asked(f)).toBe(true));
  f.close();
  const g = projectPage(true, "?tab=automations");
  expect(await screen.findByRole("heading", { name: "Triggers" })).toBeTruthy();
  g.close();
});
