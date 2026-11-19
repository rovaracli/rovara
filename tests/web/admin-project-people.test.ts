// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
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

function mount(options: { role?: "owner" | "admin" | "member"; entry?: string; projectAdmin?: boolean; refuseWrite?: number; refuseProject?: boolean; membersRead?: () => Promise<ApiResponse>; refuseCandidates?: boolean; removed?: boolean } = {}) {
 const role = options.role ?? "owner", me = meFixture(); me.developer.orgRole = role;
 // Deliberately overstate navigation/project edit authority. Only the members GET may authorize these controls.
 const nav = navFixture({ me: { developerId: FIXTURE_DEVELOPER, name: "Priya", orgRole: "owner" }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 let members = [person];
 const f = fakeHost(async (request: ApiRequest) => {
  if (request.path.endsWith("/me")) return { status: 200, body: structuredClone(me) };
  if (request.path.endsWith("/nav")) return { status: 200, body: nav };
  if (request.path.endsWith("/lifecycle")) return { status: 200, body: { status: "active", actions: [] } };
  if (request.path === "/v1/app/projects/payments") return options.refuseProject ? refuse(404) : { status: 200, body: project };
  if (request.path === "/v1/app/projects/payments/overview") return options.refuseProject ? refuse(404) : { status: 200, body: { project: { ...project, channels: [] }, you: { role: "maintainer", canStartWork: false, canEditSettings: true, canViewSpend: false }, agents: [], running: [] } };
  if (request.path === "/v1/app/org/members") return options.refuseCandidates || role === "member" ? refuse(403) : { status: 200, body: { members: [{ developerId: otherDeveloper, name: "Maya", role: "member", email: "private@example.test" }] } };
  if (request.path === "/v1/app/projects/payments/members" && request.method === "GET") return options.membersRead?.() ?? (role === "member" && !options.projectAdmin ? refuse(403) : { status: 200, body: { members } });
  if (request.path.endsWith(`/members/${otherDeveloper}`) && ["PUT", "DELETE"].includes(request.method)) {
   if (options.refuseWrite !== undefined) return refuse(options.refuseWrite);
   if (request.path.includes("/another/") || role === "member" && !options.projectAdmin) return refuse(403);
   if (request.method === "PUT") {
    if (!members.some(member => member.developerId === otherDeveloper)) members = [...members, person];
    return { status: 200, body: { member: { developerId: otherDeveloper, role: "contributor" } } };
   }
   if (options.removed !== false) members = members.filter(member => member.developerId !== otherDeveloper);
   return { status: 200, body: { developerId: otherDeveloper, removed: options.removed ?? true } };
  }
  return refuse(404);
 });
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.entry ?? "/app/projects/payments?tab=settings"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, query, router, members: () => members, writes: () => f.request.mock.calls.map(([r]) => r).filter(r => ["PUT", "DELETE", "POST"].includes(r.method)), close() { view.unmount(); router.dispose(); query.clear(); } };
}

it.each(["owner", "admin"] as const)("lets a company %s pick a member by name, add by ID and remove in project Settings", async role => {
 const f = mount({ role });
 try {
  await screen.findByRole("combobox", { name: "Company member" }, { timeout: 5000 });
  await expectNoAxeViolations(document.body);
  expect(document.body.textContent).not.toContain("private@example.test");
  expect(screen.queryByRole("textbox", { name: /email|developer ID/i })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Grant access" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Remove access for Maya" }));
  await screen.findByText("Access removed.");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove access for Maya" })).toBeNull());
  fireEvent.change(await screen.findByRole("combobox", { name: "Company member" }), { target: { value: otherDeveloper } });
  fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
  await screen.findByText("Access granted.");
  fireEvent.click(await screen.findByRole("button", { name: "Remove access for Maya" }));
  await screen.findByText("Access removed.");
  await waitFor(() => expect(f.members()).toHaveLength(0));
  expect(f.writes().map(r => [r.method, r.path])).toEqual([
   ["DELETE", `/v1/app/projects/payments/members/${otherDeveloper}`], ["PUT", `/v1/app/projects/payments/members/${otherDeveloper}`], ["DELETE", `/v1/app/projects/payments/members/${otherDeveloper}`],
  ]);
 } finally { f.close(); }
});

it("lets a company member who administers this project remove, with no Add or company role control", async () => {
 const f = mount({ role: "member", projectAdmin: true });
 try {
  fireEvent.click(await screen.findByRole("button", { name: "Remove access for Maya" }));
  await screen.findByText("Access removed.");
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove access for Maya" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/members")).toBe(false);
  expect(f.writes().map(r => r.method)).toEqual(["DELETE"]);
  await expectNoAxeViolations(document.body);
 } finally { f.close(); }
});

it("keeps the existing owner/admin Admin entry working with the same picker", async () => {
 const f = mount({ role: "admin", entry: "/app/admin/projects/payments" });
 try { await screen.findByRole("combobox", { name: "Company member" });expect(screen.getByRole("button", { name: "Remove access for Maya" })).toBeTruthy(); }
 finally { f.close(); }
});

it("keeps company members out of company Admin", async () => {
 const f = mount({ role: "member", projectAdmin: true, entry: "/app/admin/projects/payments" });
 try { await screen.findByRole("heading", { name: "Administration unavailable" });expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/members"))).toBe(false); }
 finally { f.close(); }
});

it("shows a plain member no controls even with a cached owner navigation role and editable project", async () => {
 const f = mount({ role: "member" });
 try {
  await screen.findByText("You don't have permission to view project people.");
  expect(screen.queryByRole("button", { name: /Grant access|Remove access/ })).toBeNull();
  expect(f.writes()).toEqual([]);
  await expectNoAxeViolations(document.body);
 } finally { f.close(); }
});

it("offers nothing to an owner when the live project-members GET refuses", async () => {
 const f = mount({ membersRead: async () => refuse(403) });
 try {
  await screen.findByText("You don't have permission to view project people.");
  expect(screen.queryByRole("button", { name: /Grant access|Remove access/ })).toBeNull();
  expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/members")).toBe(false);
 } finally { f.close(); }
});

it("waits for the live GET and hides controls on a refused refresh", async () => {
 let finish!: (value: ApiResponse) => void;
 let answer = new Promise<ApiResponse>(resolve => { finish = resolve; });
 const f = mount({ role: "member", projectAdmin: true, membersRead: () => answer });
 try {
  await screen.findByRole("heading", { name: "Project people" });
  expect(screen.queryByRole("button", { name: /Grant access|Remove access/ })).toBeNull();
  await act(async () => { finish({ status: 200, body: { members: [person] } }); });
  await screen.findByRole("button", { name: "Remove access for Maya" });
  answer = Promise.resolve(refuse(403));
  fireEvent.click(screen.getByRole("button", { name: "Refresh project people" }));
  await screen.findByText("You don't have permission to view project people.");
  expect(screen.queryByRole("button", { name: /Grant access|Remove access/ })).toBeNull();
 } finally { f.close(); }
});

it("does not carry project-admin permission or a person's name into another project's Settings", async () => {
 const f = mount({ role: "member", projectAdmin: true });
 try {
  await screen.findByRole("button", { name: "Remove access for Maya" });
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async r => {
   if (r.path === "/v1/app/projects/another/overview") return { status: 200, body: { project: { ...project, name: "another", channels: [] }, you: { role: "maintainer", canStartWork: false, canEditSettings: true, canViewSpend: false }, agents: [], running: [] } };
   if (r.path === "/v1/app/projects/another/members") return refuse(403);
   return original(r);
  });
  await act(async () => { await f.router.navigate("/app/projects/another?tab=settings"); });
  await screen.findByText("You don't have permission to view project people.");
  expect(screen.queryByRole("button", { name: /Grant access|Remove access/ })).toBeNull();
  expect(screen.queryByText("Maya")).toBeNull();
  expect(f.writes()).toEqual([]);
 } finally { f.close(); }
});

it("does not fetch another company's project people after the project is refused", async () => {
 const f = mount({ role: "admin", refuseProject: true, entry: "/app/admin/projects/payments" });
 try { await screen.findByText("project details unavailable. It may not exist or be visible to you.");expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/members"))).toBe(false); }
 finally { f.close(); }
});

it("offers no Add when the company directory refuses, but keeps project-authorized removal", async () => {
 const f = mount({ refuseCandidates: true });
 try {
  await screen.findByText("You don't have permission to view company members.");
  expect(screen.queryByRole("button", { name: "Grant access" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove access for Maya" })).toBeTruthy();
 } finally { f.close(); }
});

it.each([[403, "You don't have permission to change access for this project."], [404, "This project or person isn't available in your company."]] as const)("shows a safe refusal when the write returns %i", async (status, message) => {
 const f = mount({ refuseWrite: status });
 try {
  fireEvent.click(await screen.findByRole("button", { name: "Remove access for Maya" }));
  expect(await screen.findByText(message)).toHaveProperty("role", "alert");
  expect(document.body.textContent).not.toContain("private upstream details");
  expect(f.members()).toHaveLength(1);
 } finally { f.close(); }
});

it("never announces removal when Code says it was not applied", async () => {
 const f = mount({ removed: false });
 try {
  fireEvent.click(await screen.findByRole("button", { name: "Remove access for Maya" }));
  await screen.findByText("Access was not removed. Refresh the project people list and try again.");
  expect(screen.queryByText("Access removed.")).toBeNull();expect(f.members()).toHaveLength(1);
 } finally { f.close(); }
});
