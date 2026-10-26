// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const member = { developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" };
function mount(options: { path?: string; role?: "owner" | "admin" | "member"; theme?: "light" | "dark"; enabled?: boolean; kind?: "web" | "desktop"; respond?: (r: ApiRequest) => Promise<ApiResponse> } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { ...features, admin: options.enabled ?? true } });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => options.respond?.(r) ?? { status: 200, body: r.path === "/v1/app/nav" ? nav : r.path === "/v1/app/me" ? me : { members: [member] } });
 f.host.kind = options.kind ?? "web";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/admin/people"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, me, close: () => { view.unmount();router.dispose();query.clear(); } };
}
for (const role of ["owner", "admin"] as const) it(`lets an ${role} inspect people and navigate to role explanations`, async () => {
 const f = mount({ role });expect(await screen.findByRole("heading", { name: "People" })).toBeTruthy();expect(await screen.findByText("Maya")).toBeTruthy();
 expect(screen.getByRole("table", { name: "Company members" })).toBeTruthy();expect(screen.getByText("GitHub")).toBeTruthy();
 fireEvent.click(screen.getByRole("link", { name: "Roles explained" }));expect(await screen.findByRole("heading", { name: "Roles" })).toBeTruthy();expect(screen.getByText("Maintainer")).toBeTruthy();expect(screen.getByText("View project spending")).toBeTruthy();
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});
it("does not request people for a member, including a project maintainer represented by the member org role", async () => {
 const f = mount({ role: "member" });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/members")).toBe(false);f.close();
});
it("keeps disabled admin deep links absent", async () => { const f = mount({ enabled: false });expect(await screen.findByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeTruthy();expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/me")).toBe(false);f.close(); });
it("waits for fresh identity before requesting people", async () => {
 let resolve!: (r: ApiResponse) => void;const pending = new Promise<ApiResponse>(r => { resolve = r; });const f = mount({ respond: async r => r.path === "/v1/app/me" ? pending : { status: 200, body: { members: [member] } } });
 expect(await screen.findByText("Checking administration access")).toBeTruthy();expect(f.request.mock.calls.some(([r]) => r.path.includes("/members"))).toBe(false);resolve({ status: 403, body: { error: { code: "FORBIDDEN", message: "untrusted upstream detail" } } });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(screen.queryByText("untrusted upstream detail")).toBeNull();f.close();
});
it("treats an unknown identity role as unavailable", async () => { const f = mount({ respond: async () => ({ status: 200, body: { developer: { id: "a".repeat(64), name: "Priya", orgRole: "future-role" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } }) });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();f.close(); });
it("clears visible people and the directory cache when the role is revoked", async () => {
 const f = mount();await screen.findByText("Maya");f.me.developer.orgRole = "member";await f.query.invalidateQueries({ queryKey: ["admin", "identity"] });await waitFor(() => expect(screen.queryByText("Maya")).toBeNull());expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(f.query.getQueriesData({ queryKey: ["admin", "members"] })).toEqual([]);f.close();
});
it("does not present failed reads as empty and can retry", async () => {
 let failed = true;const f = mount({ respond: async r => r.path.endsWith("/members") ? failed ? { status: 403, body: { error: { code: "FORBIDDEN", message: "private provider response" } } } : { status: 200, body: { members: [] } } : { status: 200, body: AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "admin" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] }) } });
 expect(await screen.findByText("Couldn't load company members. Try again.")).toBeTruthy();expect(screen.queryByText("No company members were returned.")).toBeNull();expect(screen.queryByText("private provider response")).toBeNull();failed = false;fireEvent.click(screen.getByRole("button", { name: "Try again" }));expect(await screen.findByText("No company members were returned.")).toBeTruthy();f.close();
});
it("searches only loaded members and renders hostile names as text", async () => {
 const f = mount({ respond: async r => r.path.endsWith("/members") ? { status: 200, body: { members: [member, { ...member, developerId: "c".repeat(64), name: "<script>hostile</script>", joinedAt: "invalid", identities: [] }] } } : { status: 200, body: AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] }) } });
 await screen.findByText("<script>hostile</script>");expect(f.container.querySelector("script")).toBeNull();expect(screen.getByText("Date unavailable")).toBeTruthy();fireEvent.change(screen.getByRole("searchbox", { name: "Find in this member list" }), { target: { value: "nobody" } });expect(screen.getByText("No matching members in this list.")).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();f.close();
});
it("overview explains available administration without pretending health is verified", async () => { const f = mount({ path: "/app/admin" });expect(await screen.findByRole("heading", { name: "Administration" })).toBeTruthy();expect(screen.getByText("Review who belongs to Acme and what each role allows.")).toBeTruthy();expect(screen.queryByText("All systems healthy")).toBeNull();expect(screen.queryByRole("link", { name: "Spending" })).toBeNull();f.close(); });
for (const theme of ["light", "dark"] as const) it(`has accessible People and Roles pages in ${theme}`, async () => { const f = mount({ theme });await screen.findByText("Maya");await expectNoAxeViolations(f.container);fireEvent.click(screen.getByRole("link", { name: "Roles explained" }));await screen.findByRole("heading", { name: "Roles" });await expectNoAxeViolations(f.container);f.close(); });

it("does not load admin data in a desktop host", async () => { const f = mount({ kind: "desktop" });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(f.request).not.toHaveBeenCalled();f.close(); });
it("hides cached directory data when an identity refresh fails", async () => {
 const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "untrusted detail" } } }));await f.query.invalidateQueries({ queryKey: ["admin", "identity"] });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();expect(screen.queryByText("untrusted detail")).toBeNull();expect(f.query.getQueriesData({ queryKey: ["admin", "members"] })).toEqual([]);f.close();
});
it("rejects an unreadable directory without rendering a partial list", async () => {
 const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 200, body: { members: [member, { name: "incomplete" }] } }));await f.query.invalidateQueries({ queryKey: ["admin", "members"] });expect(await screen.findByText("Couldn't load company members. Try again.")).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();f.close();
});

it("keeps the member-name filter when inspecting roles and returning", async () => {
 const f = mount();await screen.findByText("Maya");fireEvent.change(screen.getByRole("searchbox", { name: "Find in this member list" }), { target: { value: "Maya" } });fireEvent.click(screen.getByRole("link", { name: "Roles explained" }));await screen.findByRole("heading", { name: "Roles" });fireEvent.click(screen.getByRole("link", { name: "Back to people" }));await screen.findByText("Maya");expect(screen.getByRole("searchbox")).toHaveProperty("value", "Maya");f.close();
});
