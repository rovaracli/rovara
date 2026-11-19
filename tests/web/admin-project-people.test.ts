// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture, FIXTURE_DEVELOPER } from "./support/fixtures.js";
import { expectNoAxeViolations } from "./support/axe.js";

const otherDeveloper = "b".repeat(64);
const project = { name: "payments", description: "Payment service", status: "active", latestRevision: 3, repositories: [], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: [], testCommands: [], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-01T00:00:00Z", createdBy: { developerId: FIXTURE_DEVELOPER, name: "Priya" } };
const person = { developerId: otherDeveloper, name: "Maya", role: "contributor", source: "grant" };
const refuse = (status: number): ApiResponse => ({ status, body: { error: { code: status === 404 ? "NOT_FOUND" : "FORBIDDEN", message: "private upstream details" } } });

function mount(options: { role?: "owner" | "admin" | "member"; refuseWrite?: number; refuseProject?: boolean } = {}) {
 const me = meFixture(); me.developer.orgRole = options.role ?? "owner";
 const nav = navFixture({ me: { developerId: FIXTURE_DEVELOPER, name: "Priya", orgRole: options.role ?? "owner" }, projects: [], features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 let members = [person];
 const f = fakeHost(async (request: ApiRequest) => {
  if (request.path.endsWith("/me")) return { status: 200, body: structuredClone(me) };
  if (request.path.endsWith("/nav")) return { status: 200, body: { ...nav, projects: members.length === 0 ? [] : [{ name: "payments", agents: [] }] } };
  if (request.path.endsWith("/lifecycle")) return { status: 200, body: { status: "active", actions: ["archive"] } };
  if (request.path === "/v1/app/projects/payments") return options.refuseProject ? refuse(404) : { status: 200, body: project };
  if (request.path === "/v1/app/projects/payments/members" && request.method === "GET") return { status: 200, body: { members } };
  if (request.path.endsWith(`/members/${otherDeveloper}`) && request.method === "PUT") {
   if (options.refuseWrite !== undefined) return refuse(options.refuseWrite);
   if (!members.some(member => member.developerId === otherDeveloper)) members = [...members, person];
   return { status: 200, body: { member: { developerId: otherDeveloper, role: "contributor" } } };
  }
  if (request.path.endsWith(`/members/${otherDeveloper}`) && request.method === "DELETE") {
   if (options.refuseWrite !== undefined) return refuse(options.refuseWrite);
   members = members.filter(member => member.developerId !== otherDeveloper);
   return { status: 200, body: { developerId: otherDeveloper, removed: true } };
  }
  return { status: 200, body: { members: [] } };
 });
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/projects/payments"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, members: () => members, close() { view.unmount(); router.dispose(); query.clear(); } };
}

it("lets company owners and admins grant and remove a project member", async () => {
 for (const role of ["owner", "admin"] as const) {
  const f = mount({ role });
  try {
   await screen.findByRole("table", { name: "Project people" });
   await expectNoAxeViolations(document.body);
   expect(screen.getByRole("button", { name: "Grant access" })).toBeTruthy();
   expect(document.querySelector('a[href="/app/projects/payments"]')).toBeNull();
   fireEvent.click(screen.getByRole("button", { name: "Remove access for Maya" }));
   await screen.findByText("Access removed.");
   await waitFor(() => expect(f.members()).toHaveLength(0));
   await waitFor(() => expect(document.querySelector('a[href="/app/projects/payments"]')).toBeNull());
   fireEvent.change(screen.getByRole("textbox", { name: "Person's email or developer ID" }), { target: { value: otherDeveloper } });
   fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
   await screen.findByText("Access granted.");
   await waitFor(() => expect(f.members()).toHaveLength(1));
   await waitFor(() => expect(document.querySelector('a[href="/app/projects/payments"]')).not.toBeNull());
   fireEvent.click(screen.getByRole("button", { name: "Remove access for Maya" }));
   await screen.findByText("Access removed.");
   await waitFor(() => expect(document.querySelector('a[href="/app/projects/payments"]')).toBeNull());
  } finally { f.close(); }
 }
});

it("does not show the project people page to a company member", async () => {
 const f = mount({ role: "member" });
 try {
  await screen.findByRole("heading", { name: "Administration unavailable" });
  expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/members"))).toBe(false);
 } finally { f.close(); }
});

it("does not fetch another company's project people after Code refuses the project", async () => {
 const f = mount({ role: "admin", refuseProject: true });
 try {
  await screen.findByText("project details unavailable. It may not exist or be visible to you.");
  expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/members"))).toBe(false);
 } finally { f.close(); }
});

it.each([[403, "You don't have permission to change access for this project."], [404, "This project or person isn't available in your company."]] as const)("shows a safe refusal when the route returns %i", async (status, message) => {
 const f = mount({ refuseWrite: status });
 try {
  await screen.findByRole("button", { name: "Remove access for Maya" });
  fireEvent.click(screen.getByRole("button", { name: "Remove access for Maya" }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByText(message).getAttribute("role")).toBe("alert");
  expect(document.body.textContent).not.toContain("private upstream details");
  expect(f.members()).toHaveLength(1);
 } finally { f.close(); }
});
