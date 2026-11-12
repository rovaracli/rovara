// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/cloud-contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { userEvent } from "@testing-library/user-event";
import { expectNoAxeViolations } from "./support/axe.js";
import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const member = { developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" };
function mount(options: { path?: string; role?: "owner" | "admin" | "member"; theme?: "light" | "dark"; enabled?: boolean; kind?: "web" | "desktop"; state?: unknown; respond?: (r: ApiRequest) => Promise<ApiResponse> } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { ...features, admin: options.enabled ?? true } });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => options.respond?.(r) ?? { status: 200, body: r.path === "/v1/app/nav" ? nav : r.path === "/v1/app/me" ? me : r.path === "/v1/app/home" ? { cards: [], total: 0 } : { members: [member] } });
 f.host.kind = options.kind ?? "web";
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [{ pathname: options.path ?? "/app/admin/people", state: options.state }] });
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
it("purges every admin cache area, including lane B project caches, when access is lost", async () => {
 const f = mount();await screen.findByText("Maya");
 const projects = ["admin", "projects", "org_aaaaaaaaaaaaaaaaaaaa", "a".repeat(64)], detail = ["admin", "project-detail", "org_aaaaaaaaaaaaaaaaaaaa", "a".repeat(64), "project_1"];
 f.query.setQueryData(projects, { projects: [{ name: "Secret roadmap" }] });f.query.setQueryData(detail, { name: "Secret roadmap" });
 f.me.developer.orgRole = "member";await f.query.invalidateQueries({ queryKey: ["admin", "identity"] });
 expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();
 expect(f.query.getQueryData(projects)).toBeUndefined();expect(f.query.getQueryData(detail)).toBeUndefined();expect(f.query.getQueriesData({ queryKey: ["admin", "members"] })).toEqual([]);
 f.close();
});
it("clears visible people and the directory cache when the role is revoked", async () => {
 const f = mount();await screen.findByText("Maya");f.me.developer.orgRole = "member";await f.query.invalidateQueries({ queryKey: ["admin", "identity"] });await waitFor(() => expect(screen.queryByText("Maya")).toBeNull());expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(f.query.getQueriesData({ queryKey: ["admin", "members"] })).toEqual([]);f.close();
});
it("does not present failed reads as empty and can retry", async () => {
 let failed = true;const f = mount({ respond: async r => r.path.endsWith("/members") ? failed ? { status: 404, body: { error: { code: "FORBIDDEN", message: "private provider response" } } } : { status: 200, body: { members: [] } } : { status: 200, body: AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "admin" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] }) } });
 expect(await screen.findByText("Couldn't load company members. Try again.")).toBeTruthy();expect(screen.queryByText("No company members were returned.")).toBeNull();expect(screen.queryByText("private provider response")).toBeNull();failed = false;fireEvent.click(screen.getByRole("button", { name: "Try again" }));expect(await screen.findByText("No company members were returned.")).toBeTruthy();f.close();
});
it("searches only loaded members and renders hostile names as text", async () => {
 const f = mount({ respond: async r => r.path.endsWith("/members") ? { status: 200, body: { members: [member, { ...member, developerId: "c".repeat(64), name: "<script>hostile</script>", joinedAt: "invalid", identities: [] }] } } : { status: 200, body: AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] }) } });
 await screen.findByText("<script>hostile</script>");expect(f.container.querySelector("script")).toBeNull();expect(screen.getByText("Date unavailable")).toBeTruthy();fireEvent.change(screen.getByRole("searchbox", { name: "Find in this member list" }), { target: { value: "nobody" } });expect(screen.getByText("No matching members in this list.")).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();f.close();
});
it("overview explains available administration without pretending health is verified", async () => { const f = mount({ path: "/app/admin" });expect(await screen.findByRole("heading", { name: "Company settings" })).toBeTruthy();expect(screen.getByText(/Everything about how Acme uses Rovara/)).toBeTruthy();expect(screen.queryByText("All systems healthy")).toBeNull();expect(screen.getByText("What the company spent this month, what is held for work in progress, and what is left.")).toBeTruthy();expect(screen.queryByText(/^Read company/)).toBeNull();expect(screen.getByRole("link", { name: "Spending" }).getAttribute("href")).toBe("/app/admin/money/budgets");expect(screen.getByRole("link", { name: "Review this month's spend" }).getAttribute("href")).toBe("/app/admin/money/budgets");f.close(); });
for (const theme of ["light", "dark"] as const) it(`has accessible People and Roles pages in ${theme}`, async () => { const f = mount({ theme });await screen.findByText("Maya");await expectNoAxeViolations(f.container);fireEvent.click(screen.getByRole("link", { name: "Roles explained" }));await screen.findByRole("heading", { name: "Roles" });await expectNoAxeViolations(f.container);f.close(); });

it("does not load admin data in a desktop host", async () => { const f = mount({ kind: "desktop" });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(f.request.mock.calls.map(([request]) => request.path).filter(path => path !== "/v1/app/insights"), "no admin read (the shell's Insights entry check is not admin data)").toEqual([]);f.close(); });
it("hides cached directory data when an identity refresh fails", async () => {
 const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "untrusted detail" } } }));await f.query.invalidateQueries({ queryKey: ["admin", "identity"] });expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();expect(screen.queryByText("untrusted detail")).toBeNull();expect(f.query.getQueriesData({ queryKey: ["admin", "members"] })).toEqual([]);f.close();
});
it("rejects an unreadable directory without rendering a partial list", async () => {
 const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 200, body: { members: [member, { name: "incomplete" }] } }));await f.query.invalidateQueries({ queryKey: ["admin", "members"] });expect(await screen.findByText("Couldn't load company members. Try again.")).toBeTruthy();expect(screen.queryByText("Maya")).toBeNull();f.close();
});

it("keeps the member-name filter when inspecting roles and returning", async () => {
 const f = mount();await screen.findByText("Maya");fireEvent.change(screen.getByRole("searchbox", { name: "Find in this member list" }), { target: { value: "Maya" } });fireEvent.click(screen.getByRole("link", { name: "Roles explained" }));await screen.findByRole("heading", { name: "Roles" });fireEvent.click(screen.getByRole("link", { name: "Back to people" }));await screen.findByText("Maya");expect(screen.getByRole("searchbox")).toHaveProperty("value", "Maya");f.close();
});

function pendingResponse() { let resolve!: (r: ApiResponse) => void;return { promise: new Promise<ApiResponse>(r => { resolve = r; }), resolve: (r: ApiResponse) => resolve(r) }; }
for (const field of ["org", "developer"] as const) it(`isolates the mounted directory when the ${field} changes`, async () => {
 const f = mount();await screen.findByText("Maya");const oldKey = ["admin", "members", f.me.org.orgId, f.me.developer.id];const next = structuredClone(f.me);
 if (field === "org") { next.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";next.org.name = "Other company"; } else next.developer.id = "c".repeat(64);
 const response = pendingResponse();let reads = 0;f.request.mockImplementation(async r => { if (r.path === "/v1/app/me") return { status: 200, body: next };if (r.path === "/v1/app/org/members") { reads++;return response.promise; }return { status: 200, body: {} }; });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });
 await waitFor(() => expect(reads).toBe(1));expect(screen.queryByText("Maya")).toBeNull();
 await act(async () => response.resolve({ status: 200, body: { members: [{ ...member, developerId: "d".repeat(64), name: "New directory person" }] } }));await screen.findByText("New directory person");expect(screen.queryByText("Maya")).toBeNull();await waitFor(() => expect(f.query.getQueryData(oldKey)).toBeUndefined());
 expect(f.query.getQueriesData({ queryKey: ["admin", "members"] }).map(([key]) => key)).toEqual([["admin", "members", next.org.orgId, next.developer.id]]);f.close();
});
for (const key of ["identity", "members"] as const) it(`keeps the page and focus mounted during a background ${key} recheck`, async () => {
 const f = mount();await screen.findByText("Maya");const input = screen.getByRole("searchbox"), heading = screen.getByRole("heading", { name: "People" }), table = screen.getByRole("table");input.focus();const response = pendingResponse();
 f.request.mockImplementation(async r => key === "identity" && r.path.endsWith("/me") || key === "members" && r.path.endsWith("/members") ? response.promise : { status: 200, body: r.path.endsWith("/me") ? f.me : { members: [member] } });
 let refresh!: Promise<unknown>;await act(async () => { refresh = f.query.invalidateQueries({ queryKey: ["admin", key] });await new Promise(resolve => setTimeout(resolve, 25)); });
 expect(screen.getByRole("heading", { name: "People" })).toBe(heading);expect(screen.getByRole("table")).toBe(table);expect(document.activeElement).toBe(input);expect(screen.queryByRole("progressbar")).toBeNull();
 await act(async () => { response.resolve({ status: 200, body: key === "identity" ? f.me : { members: [member] } });await refresh; });expect(screen.getByRole("searchbox")).toBe(input);expect(document.activeElement).toBe(input);f.close();
});
it("labels the access-loading region busy", async () => { const response = pendingResponse(), f = mount({ respond: () => response.promise });const progress = await screen.findByRole("progressbar", { name: "Checking administration access" });expect(progress.closest('[aria-busy="true"]')).not.toBeNull();await act(async () => response.resolve({ status: 403, body: {} }));f.close(); });
it("labels the first members load busy", async () => { const response = pendingResponse(), f = mount();await screen.findByText("Maya");f.close();const other = mount({ respond: async r => r.path.endsWith("/me") ? { status: 200, body: f.me } : response.promise });const progress = await screen.findByRole("progressbar", { name: "Loading company members" });expect(progress.closest('[aria-busy="true"]')).not.toBeNull();await act(async () => response.resolve({ status: 200, body: { members: [] } }));other.close(); });
it("explains a members permission refusal", async () => { const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 403, body: {} }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "members"] }); });expect(await screen.findByText("You don't have permission to view company members.")).toBeTruthy();f.close(); });
it("describes a failed background identity recheck and preserves the route", async () => { const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 403, body: {} }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });expect(await screen.findByText("Couldn't re-check your administration access. Try again.")).toBeTruthy();expect(f.router.state.location.pathname).toBe("/app/admin/people");expect(screen.queryByText("Maya")).toBeNull();f.close(); });
it("strips email and unknown metadata before caching the admin directory", async () => { const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 200, body: { members: [{ ...member, email: "synthetic@example.test", privateMetadata: "unneeded" }] } }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "members"] }); });expect(f.query.getQueriesData({ queryKey: ["admin", "members"] }).map(([,data]) => data)).toEqual([{ members: [member] }]);f.close(); });
it("supports one self member, empty identity methods, long wrapping names and keyboard controls", async () => {
 const f = mount();await screen.findByText("Maya");const longName = "Long display name ".repeat(30);f.request.mockImplementation(async () => ({ status: 200, body: { members: [{ ...member, developerId: f.me.developer.id, name: longName.trim(), identities: [] }] } }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "members"] }); });expect(await screen.findByText("None returned")).toBeTruthy();expect(screen.getByText("(you)")).toBeTruthy();expect(screen.getByRole("status").textContent).toBe("1 of 1 members");
 const user = userEvent.setup();screen.getByRole("heading", { name: "People" }).focus();await user.tab();expect(document.activeElement).toBe(screen.getByRole("link", { name: "Roles explained" }));await user.tab();expect(document.activeElement).toBe(screen.getByRole("searchbox"));expect(screen.getByRole("table").textContent).toContain(longName.trim());f.close();
});

it("uses sign-in recovery after a members 401 and hides cached rows", async () => { const f = mount();f.host.currentPath = () => "/app/admin/people";await screen.findByText("Maya");f.request.mockImplementation(async () => ({ status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Sign in" } } }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "members"] }); });expect(f.host.signIn).toHaveBeenCalledWith("/app/admin/people", { automatic: true });await waitFor(() => expect(screen.queryByText("Maya")).toBeNull());f.close(); });

it("cancels and evicts an old-org background read before its late response", async () => {
 const f = mount();await screen.findByText("Maya");const oldKey = ["admin", "members", f.me.org.orgId, f.me.developer.id], delayed = pendingResponse();let calls = 0;const next = structuredClone(f.me);next.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";
 f.request.mockImplementation(async r => r.path.endsWith("/me") ? { status: 200, body: next } : ++calls === 1 ? delayed.promise : { status: 200, body: { members: [{ ...member, name: "New scope" }] } });
 try { await act(async () => { void f.query.invalidateQueries({ queryKey: ["admin", "members"] });await new Promise(resolve => setTimeout(resolve, 25)); });await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await screen.findByText("New scope");expect(f.query.getQueryData(oldKey)).toBeUndefined();await act(async () => delayed.resolve({ status: 200, body: { members: [member] } }));expect(screen.queryByText("Maya")).toBeNull(); }
 finally { delayed.resolve({ status: 200, body: { members: [member] } });f.close(); }
});

it("requires an explicit role review and verifies canonical data before showing a receipt", async () => {
 let current = { ...member }, writes = 0;const f = mount({ respond: async r => {
  if (r.method === "PUT") { writes++;expect(r.body).toMatchObject({ expectedRole: "member", role: "admin" });expect(typeof (r.body as {requestId:string}).requestId).toBe("string");current = { ...member, role: "admin" };return { status: 200, body: { developerId: member.developerId, role: "admin", requestId: "envelope" } }; }
  return { status: 200, body: r.path.endsWith("/members") ? { members: [current] } : f.me };
 } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));expect(screen.getByRole("dialog", { name: "Change company role" })).toBeTruthy();expect(screen.getByText("Current role: Member")).toBeTruthy();
 fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));expect(writes).toBe(0);expect(screen.getByText("Proposed role: Admin")).toBeTruthy();expect(screen.getByText(/maintainer access to every project/)).toBeTruthy();expect(screen.getByText(/at least one owner/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));await screen.findByText("Company role verified: Admin.");expect(screen.getByText("Previous role: Member")).toBeTruthy();expect(screen.queryByText("Current role: Member")).toBeNull();expect(writes).toBe(1);expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/members"))).toHaveLength(2);f.close();
});
it("keeps admins read-only and never offers an unknown target role for editing", async () => {
 const f = mount({ role: "admin" });await screen.findByText("Maya");expect(screen.queryByRole("button", { name: /Change role/ })).toBeNull();f.close();
 const u = mount({ respond: async r => ({ status: 200, body: r.path.endsWith("/members") ? { members: [{ ...member, role: "unknown" }] } : u.me }) });await screen.findByText("Maya");expect(screen.queryByRole("button", { name: /Change role/ })).toBeNull();u.close();
});
it("invalidates a review when the target role changes during a background recheck", async () => {
 const f = mount();await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));
 f.request.mockImplementation(async r => ({ status: 200, body: r.path.endsWith("/members") ? { members: [{ ...member, role: "owner" }] } : f.me }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "members"] }); });
 expect(await screen.findByText("This person's role changed. Close and review again.")).toBeTruthy();expect(screen.getByRole("button", { name: "Confirm role change" }).hasAttribute("disabled")).toBe(true);expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});
it("does not claim success when the canonical role disagrees with the write receipt", async () => {
 const f = mount({ respond: async r => r.method === "PUT" ? { status: 200, body: { developerId: member.developerId, role: "admin" } } : { status: 200, body: r.path.endsWith("/members") ? { members: [member] } : f.me } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));expect(await screen.findByText("The current role could not be verified. Close and reload before making another change.")).toBeTruthy();expect(screen.queryByText("Company role verified: Admin.")).toBeNull();f.close();
});
it("blocks self-demotion when the loaded company has only one owner", async () => {
 const self = { ...member, developerId: "a".repeat(64), name: "Priya", role: "owner" };const f = mount({ respond: async r => ({ status: 200, body: r.path.endsWith("/members") ? { members: [self] } : f.me }) });
 fireEvent.click(await screen.findByRole("button", { name: "Change role for Priya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "member" } });expect(screen.getByText("Add another owner before changing your own role.")).toBeTruthy();expect(screen.getByRole("button", { name: "Review role change" }).hasAttribute("disabled")).toBe(true);f.close();
});

it("preserves dialog focus while a background identity check blocks a commit", async () => {
 const f = mount();await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));const confirm = screen.getByRole("button", { name: "Confirm role change" });confirm.focus();
 let resolve!: (value: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });f.request.mockImplementation(async r => r.path.endsWith("/me") ? pending : { status: 200, body: { members: [member] } });
 let check!: Promise<void>;act(() => { check = f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await waitFor(() => expect(confirm.getAttribute("aria-disabled")).toBe("true"));expect(document.activeElement).toBe(confirm);fireEvent.click(confirm);expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
 await act(async () => { resolve({ status: 200, body: f.me });await check; });expect(screen.getByRole("button", { name: "Confirm role change" })).toBe(confirm);expect(document.activeElement).toBe(confirm);f.close();
});
it("ignores an old scope's write response after the mounted org changes", async () => {
 let resolve!: (value: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });
 const f = mount({ respond: async r => r.method === "PUT" ? pending : { status: 200, body: r.path.endsWith("/members") ? { members: [{ ...member, name: f.me.org.orgId.endsWith("bbbb") ? "New company person" : "Maya", role: f.me.org.orgId.endsWith("bbbb") ? "admin" : "member" }] } : f.me } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));
 f.me.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await screen.findByText("New company person");
 await act(async () => { resolve({ status: 200, body: { developerId: member.developerId, role: "admin" } });await new Promise(done => setTimeout(done, 20)); });
 expect(screen.queryByText(/role verified|role changed and verified/)).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/members"))).toHaveLength(2);f.close();
});
it("bounds a stalled role write and never resends or claims its late result", async () => {
 let resolve!: (value: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });const f = mount({ respond: async r => r.method === "PUT" ? pending : { status: 200, body: r.path.endsWith("/members") ? { members: [member] } : f.me } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });try {
  fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });expect(screen.getByText("The outcome is unknown. Check the current role before making another change.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await act(async () => { resolve({ status: 200, body: { developerId: member.developerId, role: "admin" } }); });expect(screen.queryByText(/role verified|role changed and verified/)).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "PUT")).toHaveLength(1);
 } finally { vi.useRealTimers();f.close(); }
});
for (const [status, code, copy] of [[403, "FORBIDDEN", "Your permission to change company roles has ended. Close and reload."], [409, "CHANGE_STALE", "Company roles changed. Close and review again."], [409, "LAST_OWNER", "A company must keep at least one owner. Reload and review again."]] as const) it(`renders a safe ${code} refusal without optimistic success or resending`, async () => {
 const f = mount({ respond: async r => r.method === "PUT" ? { status, body: { error: { code, message: "untrusted provider detail" } } } : { status: 200, body: r.path.endsWith("/members") ? { members: [member] } : f.me } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));await screen.findByText(copy);expect(screen.queryByText("untrusted provider detail")).toBeNull();expect(screen.queryByText(/role verified|role changed and verified/)).toBeNull();expect(screen.getByRole("button", { name: "Confirm role change" }).hasAttribute("disabled")).toBe(true);expect(f.request.mock.calls.filter(([r]) => r.method === "PUT")).toHaveLength(1);f.close();
});
it("binds the self-demotion receipt to the fresh identity's org, person and actual role", async () => {
 const orgId = "org_aaaaaaaaaaaaaaaaaaaa", developerId = "a".repeat(64);
 for (const receipt of [{ orgId: "org_bbbbbbbbbbbbbbbbbbbb", developerId, role: "member" }, { orgId, developerId: "c".repeat(64), role: "member" }, { orgId, developerId, role: "admin" }]) {
  const f = mount({ path: "/app/admin", role: "member", state: { roleChange: receipt } });await screen.findByRole("heading", { name: "Administration unavailable" });expect(screen.queryByText("Your company role is now Member. Administration access has ended.")).toBeNull();f.close();
 }
 const f = mount({ path: "/app/admin", role: "member", state: { roleChange: { orgId, developerId, role: "member" } } });expect(await screen.findByText("Your company role is now Member. Administration access has ended.")).toBeTruthy();expect(screen.queryByRole("table")).toBeNull();f.close();
});

it("rechecks caller authority and removes owner controls after a role-write permission refusal", async () => {
 const f = mount({ respond: async r => { if (r.method === "PUT") { f.me.developer.orgRole = "admin";return { status: 403, body: { error: { code: "FORBIDDEN", message: "fixture denied" } } }; }return { status: 200, body: r.path.endsWith("/members") ? { members: [member] } : r.path.endsWith("/nav") ? f.query.getQueryData(["nav"]) : f.me }; } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));await waitFor(() => expect(f.container.querySelector('button[aria-label="Change role for Maya"]')).toBeNull());expect(await screen.findByText("Role change refused. Company access was checked again.")).toBeTruthy();expect(screen.getByRole("table")).toBeTruthy();f.close();
});
it("refreshes canonical roles after a conflict so reopening reviews the new role", async () => {
 let role = "member";const f = mount({ respond: async r => { if (r.method === "PUT") { role = "owner";return { status: 409, body: { error: { code: "CHANGE_STALE", message: "fixture conflict" } } }; }return { status: 200, body: r.path.endsWith("/members") ? { members: [{ ...member, role }] } : f.me }; } });
 await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));await screen.findByText("Company roles changed. Close and review again.");await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.path.endsWith("/members"))).toHaveLength(2));
 fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));expect(screen.getByText("Current role: Owner")).toBeTruthy();expect(screen.queryByText(/Company role verified/)).toBeNull();f.close();
});

it("keeps a stale last-good list and adjacent recovery when a successful write's canonical read fails", async () => {
 let wrote = false, recover = false;const f = mount({ respond: async r => { if (r.method === "PUT") { wrote = true;return { status: 200, body: { developerId: member.developerId, role: "admin" } }; }if (r.path.endsWith("/members")) return wrote && !recover ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "fixture offline" } } } : { status: 200, body: { members: [{ ...member, role: wrote ? "admin" : "member" }] } };return { status: 200, body: f.me }; } });
 await screen.findByText("Maya");const table = f.container.querySelector("table");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));
 await screen.findByText("The current role could not be verified. Close and reload before making another change.", {}, { timeout: 5000 });expect(f.container.querySelector("table")).toBe(table);expect(screen.getByRole("dialog", { name: "Change company role" })).toBeTruthy();expect(f.container.textContent).toContain("Member list is stale");const check = screen.getByRole("button", { name: "Check current role" });await waitFor(() => expect(document.activeElement).toBe(check));expect(screen.queryByText("Company role verified: Admin.")).toBeNull();
 recover = true;fireEvent.click(check);await screen.findByText("Company role verified: Admin.");expect(f.request.mock.calls.filter(([r]) => r.method === "PUT")).toHaveLength(1);f.close();
});
it("still hides a cached list on a background permission refusal", async () => {
 const f = mount();await screen.findByText("Maya");f.request.mockImplementation(async r => r.path.endsWith("/members") ? { status: 403, body: { error: { code: "FORBIDDEN", message: "fixture denied" } } } : { status: 200, body: f.me });await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "members"] }); });expect(await screen.findByText("You don't have permission to view company members.")).toBeTruthy();expect(screen.queryByRole("table")).toBeNull();f.close();
});
it("names the verified person and check time on the page receipt", async () => {
 let role = "member";const f = mount({ respond: async r => { if (r.method === "PUT") { role = "admin";return { status: 200, body: { developerId: member.developerId, role } }; }return { status: 200, body: r.path.endsWith("/members") ? { members: [{ ...member, role }] } : f.me }; } });await screen.findByText("Maya");fireEvent.click(screen.getByRole("button", { name: "Change role for Maya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));await screen.findByText("Company role verified: Admin.");fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));const receipt = (await screen.findByText(/Maya.*Admin/)).closest("[role=status]");expect(receipt?.textContent).toContain("UTC");expect(Number.isFinite(Date.parse(receipt?.querySelector("time")?.dateTime ?? ""))).toBe(true);f.close();
});
it("focuses the named receipt when an owner's verified admin demotion removes the trigger", async () => {
 let role = "owner";const self = { ...member, developerId: "a".repeat(64), name: "Priya" };const f = mount({ respond: async r => { if (r.method === "PUT") { role = "admin";f.me.developer.orgRole = "admin";return { status: 200, body: { developerId: self.developerId, role } }; }return { status: 200, body: r.path.endsWith("/members") ? { members: [{ ...self, role }, { ...member, role: "owner" }] } : r.path.endsWith("/nav") ? f.query.getQueryData(["nav"]) : f.me }; } });
 fireEvent.click(await screen.findByRole("button", { name: "Change role for Priya" }));fireEvent.change(screen.getByRole("combobox", { name: "Proposed role" }), { target: { value: "admin" } });fireEvent.click(screen.getByRole("button", { name: "Review role change" }));fireEvent.click(screen.getByRole("button", { name: "Confirm role change" }));const receipt = (await screen.findByText(/Priya.*Admin/)).closest("[role=status]");await waitFor(() => expect(document.activeElement).toBe(receipt));expect(f.container.querySelector('button[aria-label="Change role for Priya"]')).toBeNull();f.close();
});
it("consumes the own member receipt history state without redisplaying it on Back", async () => {
 const state = { roleChange: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), role: "member" } };const f = mount({ path: "/app/admin", role: "member", state });await screen.findByText("Your company role is now Member. Administration access has ended.");await waitFor(() => expect(f.router.state.location.state).toBeNull());expect(screen.getByText("Your company role is now Member. Administration access has ended.")).toBeTruthy();
 await act(async () => { await f.router.navigate("/app"); });await act(async () => { await f.router.navigate(-1); });await screen.findByRole("heading", { name: "Administration unavailable" });expect(screen.queryByText("Your company role is now Member. Administration access has ended.")).toBeNull();const saved: unknown = f.router.state.location.state;f.close();const reload = mount({ path: "/app/admin", role: "member", state: saved });await screen.findByRole("heading", { name: "Administration unavailable" });expect(screen.queryByText("Your company role is now Member. Administration access has ended.")).toBeNull();reload.close();
});
it("explains why a checking-disabled Change role trigger cannot open", async () => {
 const f = mount();const trigger = await screen.findByRole("button", { name: "Change role for Maya" });trigger.focus();let resolve!: (value: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });f.request.mockImplementation(async r => r.path.endsWith("/me") ? pending : { status: 200, body: { members: [member] } });let refresh!: Promise<void>;act(() => { refresh = f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await waitFor(() => expect(trigger.getAttribute("aria-disabled")).toBe("true"));const reason = trigger.getAttribute("aria-describedby");expect(reason).toBeTruthy();expect(document.getElementById(reason!)?.textContent).toContain("Checking company access");fireEvent.click(trigger);expect(screen.queryByRole("dialog")).toBeNull();expect(document.activeElement).toBe(trigger);await act(async () => { resolve({ status: 200, body: f.me });await refresh; });f.close();
});

for (const role of ["owner", "admin"] as const) it(`offers Health and How we work to a company ${role} without loading either page`, async () => {
 const f = mount({ role });
 try {
  await screen.findByRole("heading", { name: "People" });
  expect(screen.getByRole("link", { name: "Health" }).getAttribute("href")).toBe("/app/admin/health");
  expect(screen.getByRole("link", { name: "How we work" }).getAttribute("href")).toBe("/app/admin/how-we-work");
  expect(f.request.mock.calls.some(([r]) => /service-status|model-selection-policy/.test(r.path))).toBe(false);
 } finally { f.close(); }
});
it("admin navigation links disappear with company access", async () => {
 const f = mount({ role: "member" });
 try { await screen.findByRole("heading", { name: "Administration unavailable" });expect(screen.queryByRole("link", { name: "Health" })).toBeNull();expect(screen.queryByRole("link", { name: "How we work" })).toBeNull(); } finally { f.close(); }
});
