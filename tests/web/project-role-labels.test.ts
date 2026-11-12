// @vitest-environment jsdom
// Collaborator wherever a project role is already shown (this works with the People switch OFF), the Roles screen's words for the four roles and the new permissions, the join landing (switch `rovara.people`), and comment
// and Ask following what the server offers (`you.actions`, `you.live.ask`) rather than a role check in the page.
import { expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { PROJECT_PERMISSIONS } from "@rovara-code/contracts";
import { CLOUD_PROJECT_PERMISSIONS } from "@agentx/cloud-contracts/web";
import { projectRoleLabel } from "../../packages/ui/src/screens/admin/projects/labels.js";
import { RolesScreen } from "../../packages/ui/src/screens/admin/RolesScreen.js";
import { ProjectsScreen } from "../../packages/ui/src/screens/admin/projects/ProjectsScreen.js";
import { ProjectDetailScreen } from "../../packages/ui/src/screens/admin/projects/ProjectDetailScreen.js";
import { WelcomeScreen } from "../../packages/ui/src/screens/onboarding/WelcomeScreen.js";
import { Composer } from "../../packages/ui/src/screens/session/Composer.js";
import { SessionControls } from "../../packages/ui/src/screens/session/SessionControls.js";
import { PEOPLE_STORAGE_KEY } from "../../packages/ui/src/people-flags.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { adminContext } from "./support/admin-router.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { SESSION_FIXTURE_ID } from "./support/session-fixture.js";

const summary = (over: Record<string, unknown>) => ({ name: "payments", description: "Payments", status: "active", latestRevision: 3, repositories: [{ fullName: "acme/payments", defaultBranch: "main" }], myRole: "viewer", setup: { status: "ready" }, ...over });

function mountAdmin(respond: (request: ApiRequest) => ApiResponse) {
  const f = fakeHost(async request => respond(request)), query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: [location.hash.slice(1) || "/p"], children: h(Routes, { children: h(Route, { element: h(Outlet, { context: adminContext }), children: [h(Route, { key: "a", path: "/p", element: h(ProjectsScreen, {}) }), h(Route, { key: "b", path: "/d/:name", element: h(ProjectDetailScreen, {}) }), h(Route, { key: "c", path: "/roles", element: h(RolesScreen, {}) })] }) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}
const at = (path: string) => { location.hash = "#" + path; };

it("projectRoleLabel names all four roles", () => {
  expect(projectRoleLabel).toEqual({ maintainer: "Maintainer", contributor: "Contributor", collaborator: "Collaborator", viewer: "Viewer" });
});

it("the Roles screen shows the collaborator with words for answering, approving low-risk product decisions, commenting and asking, and no spend or start rights", async () => {
  at("/roles");
  const f = mountAdmin(() => ({ status: 200, body: {} }));
  const section = (await screen.findByRole("heading", { name: "Collaborator", level: 3 })).closest("section")!;
  for (const words of [/Answer the questions a task raises/u, /Approve low-risk product decisions/u, /Comment on a task/u, /Ask Rovara about a task/u, /View project work/u]) expect(within(section).getByText(words)).toBeTruthy();
  for (const words of [/Start tasks/u, /View project spending/u, /Edit project settings/u, /Manage project members/u]) expect(within(section).queryByText(words)).toBeNull();
  for (const role of ["Maintainer", "Contributor", "Viewer"]) expect(screen.getByRole("heading", { name: role, level: 3 })).toBeTruthy();
  await expectNoAxeViolations(f.container);
  f.close();
});

it("Cloud's permission table keeps a collaborator at a viewer's answer for every one of Code's permissions", () => {
  for (const permission of PROJECT_PERMISSIONS.viewer) expect(CLOUD_PROJECT_PERMISSIONS.collaborator).toContain(permission);
  for (const permission of PROJECT_PERMISSIONS.maintainer) if (!PROJECT_PERMISSIONS.viewer.includes(permission)) expect(CLOUD_PROJECT_PERMISSIONS.collaborator).not.toContain(permission);
});

it("with the People switch OFF the projects list still says Collaborator (myProjectRole) and falls back to the floor for an older server", async () => {
  at("/p");
  const f = mountAdmin(() => ({ status: 200, body: { projects: [summary({ name: "payments", myProjectRole: "collaborator" }), summary({ name: "checkout", myRole: "contributor" })] } }));
  expect(f.storage.get(PEOPLE_STORAGE_KEY)).toBeUndefined();
  const table = await screen.findByRole("table", { name: "Projects" });
  expect(within(within(table).getByRole("link", { name: "payments" }).closest("tr")!).getByText("Collaborator")).toBeTruthy();
  expect(within(within(table).getByRole("link", { name: "checkout" }).closest("tr")!).getByText("Contributor")).toBeTruthy();
  f.close();
});

it("with the People switch OFF a project's roster still says Collaborator (projectRole)", async () => {
  at("/d/payments");
  const f = mountAdmin(request => request.path.endsWith("/members")
    ? { status: 200, body: { members: [{ developerId: "b".repeat(64), name: "Priya Rao", role: "viewer", projectRole: "collaborator", source: "grant" }, { developerId: "c".repeat(64), name: "Lee Park", role: "viewer", source: "grant" }] } }
    : { status: 200, body: { ...summary({ myRole: "maintainer" }), settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-01T00:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" } } });
  const table = await screen.findByRole("table", { name: "Project people" });
  expect(within(within(table).getByText("Priya Rao").closest("tr")!).getByText("Collaborator")).toBeTruthy();
  expect(within(within(table).getByText("Lee Park").closest("tr")!).getByText("Viewer")).toBeTruthy();
  f.close();
});

// ---- the join landing ----
const ME = { developer: { id: "a".repeat(64), name: "Sam", orgRole: "member" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "cloud", nameIsDefault: false }, identities: [] };
function mountWelcome(search: string, on: boolean) {
  const f = fakeHost(async request => request.path === "/v1/app/me" ? { status: 200, body: ME } : { status: 200, body: {} }), query = createQueryClient();
  if (on) f.storage.set(PEOPLE_STORAGE_KEY, "v2");
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/welcome" + search], children: h(Routes, { children: h(Route, { path: "/app/welcome", element: h(WelcomeScreen, {}) }) }) }) }) }));
  return { ...f, ...ui, close() { ui.unmount();query.clear(); } };
}

it("joined through an invite that named a project: a landing with a link into the project (switch on)", async () => {
  const f = mountWelcome("?joined=1&project=payments", true), navigate = vi.spyOn(f.host, "navigate");
  expect(await screen.findByRole("heading", { name: "You joined Acme" })).toBeTruthy();
  expect(screen.getByText(/You are also on the project payments/u)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open payments" }).getAttribute("href")).toBe("/app/projects/payments");
  expect(navigate).not.toHaveBeenCalled();
  await expectNoAxeViolations(f.container);
  f.close();
});

it("joined but the project was archived or removed: says they joined the company but not the project, and links only into the app", async () => {
  for (const [note, words] of [["project_archived", /joined the company but not the project payments: it was archived/u], ["project_gone", /joined the company but not the project payments: it is no longer there/u]] as const) {
    const f = mountWelcome("?joined=1&project=payments&projectNote=" + note, true);
    expect(await screen.findByText(words)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open payments" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to Rovara" }).getAttribute("href")).toBe("/app");
    f.close();
  }
});

it("a project name that is not one is ignored, and with the switch off the welcome page goes straight to the app as before", async () => {
  const bad = mountWelcome("?joined=1&project=../../admin", true), badNavigate = vi.spyOn(bad.host, "navigate");
  await waitFor(() => { expect(badNavigate).toHaveBeenCalledWith("/app"); });
  expect(screen.queryByRole("link", { name: /^Open/u })).toBeNull();
  bad.close();
  const off = mountWelcome("?joined=1&project=payments", false), offNavigate = vi.spyOn(off.host, "navigate");
  await waitFor(() => { expect(offNavigate).toHaveBeenCalledWith("/app"); });
  expect(screen.queryByText("You joined Acme")).toBeNull();
  off.close();
});

// ---- comment and Ask follow the server ----
const send = async () => undefined;
it("comment follows the server's session actions: offered when `comment` is there (a collaborator at view level), never from a role guess", () => {
  const view = renderUi(h(Composer, { agent: "Payments expert", actions: ["watch", "comment"], onSend: send }));
  expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Message the agent" })).toBeNull();
  expect(screen.getByLabelText("Comment")).toBeTruthy();
  view.unmount();
  renderUi(h(Composer, { agent: "Payments expert", actions: ["watch"], onSend: send }));
  expect(screen.getByText("You can read this conversation.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Comment" })).toBeNull();
});

it("Ask follows the server's `you.live.ask`: shown for whoever the server offers it to, hidden otherwise, whatever the actions are", async () => {
  const mount = (ask: boolean) => {
    const f = fakeHost(async () => ({ status: 404, body: {} })), query = createQueryClient();
    const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/sessions/" + SESSION_FIXTURE_ID], children: h("main", {}, h(SessionControls, { id: SESSION_FIXTURE_ID, agent: "Payments expert", actions: ["watch", "comment"], following: false, onChanged: async () => undefined, ask })) }) }) }));
    return { ...ui, close() { ui.unmount();query.clear(); } };
  };
  const on = mount(true);
  expect(await screen.findByText("Ask about this task")).toBeTruthy();
  on.close();
  const off = mount(false);
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(screen.queryByText("Ask about this task")).toBeNull();
  off.close();
});
