// @vitest-environment jsdom
// SETUP-WIKI-CLOUD-FIXES (b): the project header says "Setup checked" once Code's checklist says the setup is done (the attention CLEARS), and no link leads to the old Setup step (its commands, check and draft routes
// are not on Code). The address Code's website-ask card opens (`/app/projects/<p>/setup`) lands on the project's checklist.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture, navFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

afterEach(cleanup);
const json = (status: number, body: unknown): ApiResponse => ({ status, body });
function mount(initial: string, setup: "ready" | "unchecked" | "unknown") {
  const overview = projectFixture();
  overview.project.setup = { status: setup };
  const nav = navFixture();
  const f = fakeHost(async (request: ApiRequest) => {
    const path = new URL(request.path, "https://x.example").pathname;
    if (path === "/v1/app/me") return json(200, meFixture());
    if (path === "/v1/app/nav") return json(200, nav);
    if (path === "/v1/app/changes") return json(200, { notices: [], next: "settled" });
    if (path === "/v1/app/projects/payments/overview") return json(200, overview);
    return json(404, { error: { code: "NOT_FOUND", message: "route not found" } });
  });
  f.storage.set("rovara.theme", "light");
  const query = createQueryClient();
  query.setQueryData(["nav"], nav);
  const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [initial] });
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(Announcer, { children: h(RouterProvider, { router }) }) }) }) }));
  return { ...f, router, close() { ui.unmount(); router.dispose(); query.clear(); } };
}

describe("setup status in the project header", () => {
  it("says Setup checked, with no attention link, when Code's checklist says the setup is done", async () => {
    const f = mount("/app/projects/payments", "ready");
    expect(await screen.findByText("Setup checked")).toBeTruthy();
    expect(screen.queryByText("Setup needs attention")).toBeNull();
    f.close();
  });
  it("a checklist that could not be read says the status is UNKNOWN: never 'ready' and never 'Setup needs attention' (no link)", async () => {
    const f = mount("/app/projects/payments", "unknown");
    expect((await screen.findByTestId("setup-unknown")).textContent).toBe("Setup status unknown. Couldn't read it just now.");
    expect(screen.queryByText("Setup needs attention")).toBeNull();
    expect(screen.queryByText("Setup checked")).toBeNull();
    expect(screen.queryByTestId("setup-attention-link")).toBeNull();
    f.close();
  });
  it("says Setup needs attention otherwise, as a link to the project checklist and never to the old Setup step", async () => {
    const f = mount("/app/projects/payments", "unchecked");
    const link = await screen.findByRole("link", { name: "Setup needs attention" });
    expect(link.getAttribute("href")).toBe("/app/projects/payments#setup-checklist");
    expect(document.body.innerHTML).not.toContain("step=setup");
    f.close();
  });
});

describe("the address Code's website-ask card opens", () => {
  it("/app/projects/<p>/setup lands on the project's checklist, not a missing page", async () => {
    const f = mount("/app/projects/payments/setup", "unchecked");
    await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/projects/payments"));
    expect(f.router.state.location.hash).toBe("#setup-checklist");
    f.close();
  });
  it("a name that is not a project name is not found (never a redirect with its text)", async () => {
    const f = mount("/app/projects/Bad%20Name/setup", "unchecked");
    await waitFor(() => expect(f.router.state.location.pathname).toBe("/app/projects/Bad%20Name/setup"));
    expect(f.router.state.location.hash).toBe("");
    f.close();
  });
});
