// @vitest-environment jsdom
// UX2 slice 2 item 7: a task can be started from Home too. The person's projects come from the sidebar's data (never fetched here); the project's own start box shows only where the project page would
// show it (`canStartWork`), and a person who can't start work is told so instead.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema, AppNavSchema } from "@agentx/contracts/web";
import { HomeStart } from "../../packages/ui/src/screens/home/HomeStart.js";
import { StartWorkBox } from "../../packages/ui/src/screens/project/StartWorkBox.js";
import { howWeWorkKey } from "../../packages/ui/src/api/how-we-work.js";
import { AppHostProvider, useAppHost } from "../../packages/ui/src/host.js";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { projectFixture } from "./support/project-fixture.js";
import { LAYER, howWeWorkView } from "./support/how-we-work-view.js";

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

// Found by the 0.5.11 CI run (name-prompt "updates the header"): HomeStart reads the sidebar's data with `skipToken`. A query takes the options of the LAST observer that set them, and a refetch runs that
// queryFn, so when Home's start box re-rendered after the shell's own observer, "invalidate nav" ran skipToken and failed, and the header kept the old name.
function NavName() {
 const host = useAppHost();
 const nav = useQuery({ queryKey: ["nav"], queryFn: () => createApiClient(host).get("/v1/app/nav", AppNavReaderSchema) });
 return h("output", { "aria-label": "name" }, nav.data?.me.name ?? "loading");
}
it("lets the shell's refetch of the sidebar data run even when Home's start box rendered last", async () => {
 let name = "Member 3fa9";
 const navBody = () => AppNavSchema.parse({ me: { developerId: "a".repeat(64), orgRole: "member", name }, org: { name: "Acme" }, homeCount: 0, projects: [{ name: "api", agents: [] }, { name: "web", agents: [] }], shared: { agents: [], sessions: [] }, features: { localAgents: true, usage: false, admin: false, chains: false, notices: false, describe: false } });
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/nav") return { status: 200, body: navBody() };
  const match = /^\/v1\/app\/projects\/([^/]+)\/overview$/u.exec(request.path);
  if (match !== null) { const base = projectFixture();return { status: 200, body: { ...base, project: { ...base.project, name: decodeURIComponent(match[1]!) } } }; }
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
 });
 const query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: [h(NavName, { key: "name" }), h(HomeStart, { key: "start" })] }) }) }));
 await waitFor(() => expect(screen.getByLabelText("name").textContent).toBe("Member 3fa9"));
 await screen.findByLabelText("Project");
 // Only the start box re-renders, so its observer sets the query's options last.
 fireEvent.change(screen.getByLabelText("Project"), { target: { value: "web" } });
 await screen.findByText("You can't start work in this project. Ask one of its maintainers.").catch(() => undefined);
 name = "Priya R";
 await query.invalidateQueries({ queryKey: ["nav"] });
 await waitFor(() => expect(screen.getByLabelText("name").textContent).toBe("Priya R"));
 ui.unmount();query.clear();
});

// The same hazard on the start box's "Runs:" line, which reads "How we work" data with no queryFn of its own.
const BUILTIN = howWeWorkView({ process: { kind: "builtin", agentId: "rovara-code" } });
function ViewProbe() {
 useQuery({ queryKey: [...howWeWorkKey("payments"), "view"], queryFn: () => Promise.resolve(BUILTIN) });
 return null;
}
it("lets a refetch of the project's How we work data run even when the start box rendered last", async () => {
 const f = fakeHost(async request => request.path.endsWith("/start-preview") ? { status: 200, body: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "disabled" } } : { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
 const query = createQueryClient();
 query.setQueryData([...howWeWorkKey("payments"), "view"], howWeWorkView());
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: [h(ViewProbe, { key: "probe" }), h(StartWorkBox, { key: "box", project: "payments", agents: [{ agentId: LAYER, name: "Payments process" }] })] }) }) }));
 // The probe's own first fetch is not due yet (the seeded view is fresh), so the line shows the seeded view until the data is invalidated.
 expect(await screen.findByText("Runs: Payments process (Rovara Code)")).toBeTruthy();
 await query.invalidateQueries({ queryKey: howWeWorkKey("payments") });
 expect(await screen.findByText("Runs: the built-in process (Rovara Code)")).toBeTruthy();
 ui.unmount();query.clear();
});
