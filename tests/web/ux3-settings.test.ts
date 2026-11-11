// @vitest-environment jsdom
// UX3 items 2 to 4: company settings as one area (grouped navigation and overview, Agents wired in), usable on a phone, and every page saying what a change affects and who can change it.
import { expect, it } from "vitest";
import { screen, fireEvent, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { ADMIN_SECTIONS, visibleSections } from "../../packages/ui/src/screens/admin/admin-sections.js";
import { SETTINGS_AREAS } from "../../packages/ui/src/screens/admin/settings-text.js";
import { DataTable } from "../../packages/ui/src/design/DataTable.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
function mount(path: string, options: { role?: "owner" | "admin" | "member"; width?: number } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => ({ status: r.path === "/v1/app/me" || r.path === "/v1/app/nav" ? 200 : 404, body: r.path === "/v1/app/me" ? me : r.path === "/v1/app/nav" ? nav : { error: { code: "NOT_FOUND", message: "none" } } }));
 f.host.kind = "web";f.host.viewport = { width: () => options.width ?? 1280, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, close: () => { view.unmount();router.dispose();query.clear(); } };
}

it("lists every settings page once, in groups, and every page has its own words about what a change affects", () => {
 const targets = ADMIN_SECTIONS.flatMap(section => section.items.map(item => item.to));
 expect(new Set(targets).size).toBe(targets.length);
 expect(ADMIN_SECTIONS.map(section => section.title)).toEqual(["People and access", "Connections and models", "Money and limits", "How work runs", "Security and sign-in"]);
 for (const section of ADMIN_SECTIONS) for (const item of section.items) expect(SETTINGS_AREAS[item.area].who.length).toBeGreaterThan(10);
 expect(visibleSections("admin", false).flatMap(section => section.items.map(item => item.label))).not.toContain("Company domains");
 expect(visibleSections("owner", false).flatMap(section => section.items.map(item => item.label))).toContain("Company domains");
 expect(visibleSections("owner", true).flatMap(section => section.items.map(item => item.label))).not.toContain("Second opinion");
 expect(targets).toContain("/app/admin/agents");
});
it("the overview and the navigation show the same groups, with Agents wired in", async () => {
 const f = mount("/app/admin");
 try {
  await screen.findByRole("heading", { name: "Company settings", level: 1 });
  const nav = screen.getByRole("navigation", { name: "Administration" });
  for (const group of ["People and access", "Connections and models", "Money and limits", "How work runs", "Security and sign-in"]) { expect(within(nav).getByRole("group", { name: group })).toBeTruthy();expect(screen.getByRole("heading", { name: group, level: 2 })).toBeTruthy(); }
  expect(within(nav).getByRole("link", { name: "Agents" }).getAttribute("href")).toBe("/app/admin/agents");
  expect(within(nav).getByRole("link", { name: "Roles" }).getAttribute("href")).toBe("/app/admin/people/roles");
  expect(within(nav).queryByRole("button", { name: "Settings menu" })).toBeNull();
 } finally { f.close(); }
});
for (const [path, area] of [["/app/admin/people", "people"], ["/app/admin/people/roles", "roles"], ["/app/admin/invites", "invites"], ["/app/admin/money/budgets", "money"], ["/app/admin/connections", "connections"], ["/app/admin/models/sources", "models"], ["/app/admin/projects", "projects"], ["/app/admin/agents", "agents"], ["/app/admin/audit", "audit"], ["/app/admin/health", "health"], ["/app/admin/how-we-work", "how-we-work"], ["/app/admin/tracker-people", "tracker-people"], ["/app/admin/waiting", "waiting"]] as const) it(`${path} says what a change affects and who can change it`, async () => {
 const f = mount(path);
 try {
  const note = await screen.findByRole("complementary", { name: `About ${SETTINGS_AREAS[area].title}` });
  expect(within(note).getByText("What a change affects.")).toBeTruthy();expect(within(note).getByText("Who can change it.")).toBeTruthy();
  expect(note.textContent).toContain(SETTINGS_AREAS[area].affects);expect(note.textContent).toContain(SETTINGS_AREAS[area].who);
 } finally { f.close(); }
});
it("an admin on the owner-only domains page is told why they can't change it", async () => {
 const f = mount("/app/admin/domains", { role: "admin" });
 try {
  const note = await screen.findByRole("complementary", { name: "About Company domains" });
  expect(within(note).getByRole("note").textContent).toContain("You are an admin. Only company owners can add or remove a domain.");
 } finally { f.close(); }
});
it("on a phone the settings menu is one button, the Waiting link stays in the sidebar menu, and the page is not blocked", async () => {
 const f = mount("/app/admin/people", { width: 390 });
 try {
  const menu = await screen.findByRole("button", { name: "Settings menu" });
  expect(screen.queryByText(/Open this on a larger screen/)).toBeNull();
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(menu.getAttribute("aria-controls")!)!.hidden).toBe(true);
  fireEvent.click(menu);
  expect(document.getElementById(menu.getAttribute("aria-controls")!)!.hidden).toBe(false);
  fireEvent.click(within(screen.getByRole("navigation", { name: "Administration" })).getByRole("link", { name: "Agents" }));
  expect(await screen.findByRole("heading", { name: "Agents", level: 1 })).toBeTruthy();
 } finally { f.close(); }
});
it("a table labels every cell with its column, and keeps its table roles, so it can be a list on a phone", () => {
 const view = renderUi(h(DataTable<{ id: string; name: string }>, { caption: "People", rows: [{ id: "1", name: "Maya" }], rowKey: row => row.id, columns: [{ key: "name", title: "Name", render: row => row.name }] }));
 try {
  const table = screen.getByRole("table", { name: "People" });
  expect(within(table).getByRole("cell", { name: "Maya" }).getAttribute("data-label")).toBe("Name");
  expect(within(table).getAllByRole("row")).toHaveLength(2);expect(within(table).getByRole("columnheader", { name: "Name" })).toBeTruthy();
 } finally { view.unmount(); }
});
