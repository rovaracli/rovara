// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", developerId = "a".repeat(64), id = "11111111-1111-4111-8111-111111111111";
const entry = { inviteId: id, revision: 0, role: "member", createdAt: "2026-10-26T12:00:00Z", expiresAt: "2026-11-02T12:00:00Z", createdBy: developerId, destination: { kind: "email", label: "***@example.test" } };
function mount(options: { role?: "owner" | "admin"; revision?: boolean; theme?: "light" | "dark" } = {}) {
 const nav = AppNavSchema.parse({ me: { developerId, name: "Priya", orgRole: options.role ?? "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { admin: true, localAgents: false, usage: false, chains: false, describe: false, notices: false } });
 const me = { developer: { id: developerId, name: "Priya", orgRole: options.role ?? "owner" as string }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 const state: Record<string, unknown> = { orgId, inviteId: id, revision: 0, role: "member", status: "pending", expiresAt: entry.expiresAt, checkedAt: "2026-10-27T12:00:00Z" };
 async function respond(r: ApiRequest): Promise<ApiResponse> {
  if (r.path.endsWith("/me")) return { status: 200, body: me };if (r.path.endsWith("/nav")) return { status: 200, body: nav };
  if (r.method === "POST") { state.status = "revoked";state.revision = 1;state.revokedAt = "2026-10-27T12:00:00Z";return { status: 200, body: { inviteId: id, revision: 1, revokedAt: state.revokedAt } }; }
  if (r.path.endsWith("/" + id)) return { status: 200, body: { ...state } };
  const row = options.revision === false ? { ...entry, revision: undefined } : entry;
  return { status: 200, body: { invites: state.status === "pending" && me.org.orgId === orgId && me.developer.id === developerId ? [row] : [], coverage: "indexed_only", checkedAt: "2026-10-27T12:00:00Z" } };
 }
 const f = fakeHost(respond);f.host.kind = "web";f.storage.set("rovara.theme", options.theme ?? "light");const query = createQueryClient();query.setQueryData(["nav"], nav);const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: ["/app/admin/invites"] });const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, me, state, respond, async open() { fireEvent.click(await screen.findByRole("button", { name: `Revoke invite ${id}` }));await screen.findByRole("dialog", { name: "Revoke invite" });await waitFor(() => expect(screen.getByRole("button", { name: "Confirm revoke" }).hasAttribute("disabled")).toBe(false)); }, close() { view.unmount();router.dispose();query.clear(); } };
}
for (const role of ["owner", "admin"] as const) it(`lets ${role} review and explicitly revoke, then verifies canonical state`, async () => {
 const f = mount({ role });try { await f.open();expect(screen.getByText("Company: Acme")).toBeTruthy();expect(screen.getByText(/People who already joined keep their access/)).toBeTruthy();expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(0);fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));await screen.findByText("Invite revoked.");const writes = f.request.mock.calls.filter(([r]) => r.method === "POST");expect(writes.length).toBe(1);expect(writes[0]?.[0].body).toMatchObject({ expectedRevision: 0 });expect(typeof (writes[0]?.[0].body as { requestId?: unknown }).requestId).toBe("string");expect(f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path.endsWith("/" + id)).length).toBe(2);expect(screen.getByRole("dialog")).toBeTruthy();expect(f.container.textContent?.includes(developerId)).toBe(false); }finally { f.close(); }
});
it("does not expose a revoke action without an authoritative server revision", async () => {
 const f = mount({ revision: false });try { await screen.findByText("***@example.test");expect(screen.queryByRole("button", { name: `Revoke invite ${id}` })).toBeNull();expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true); }finally { f.close(); }
});
it("checks fresh state before confirmation and refuses a changed revision", async () => {
 const f = mount();try { f.state.revision = 1;fireEvent.click(await screen.findByRole("button", { name: `Revoke invite ${id}` }));await screen.findByText(/Invite details changed/);expect(screen.getByRole("button", { name: "Confirm revoke" }).hasAttribute("disabled")).toBe(true);expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(0); }finally { f.close(); }
});
it("keeps a dialog and focused control during identity checks and blocks the write", async () => {
 const f = mount();try { await f.open();const button = screen.getByRole("button", { name: "Confirm revoke" });button.focus();let resolve!: (r: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });f.request.mockImplementation(async r => r.path.endsWith("/me") ? pending : f.respond(r));let refresh!: Promise<void>;act(() => { refresh = f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await screen.findAllByText("Checking company access...");expect(document.activeElement).toBe(button);fireEvent.click(button);expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(0);await act(async () => { resolve({ status: 200, body: f.me });await refresh; }); }finally { f.close(); }
});
it("never automatically resends an unknown-outcome write and only reads on deliberate recovery", async () => {
 const f = mount();try { await f.open();f.request.mockImplementation(async r => { if (r.method === "POST") { f.state.status = "revoked";f.state.revision = 1;f.state.revokedAt = "2026-10-27T12:00:00Z";throw new Error("private upstream fixture"); }return f.respond(r); });fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));await screen.findByText(/outcome is unknown/i);expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(1);expect(screen.queryByText("Invite revoked.")).toBeNull();fireEvent.click(screen.getByRole("button", { name: "Check current invite" }));await screen.findByText(/This invite is revoked. This attempt's outcome could not be confirmed/);expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(1);expect(screen.queryByText("private upstream fixture")).toBeNull(); }finally { f.close(); }
});
for (const [code, copy] of [["INVITE_ALREADY_ACCEPTED", "This invite has already been accepted. No access was revoked."], ["INVITE_ALREADY_REVOKED", "This invite was already revoked. No additional change was made."]] as const) it(`shows the ${code} terminal result without pretending this request revoked access`, async () => {
 const f = mount();try { await f.open();f.request.mockImplementation(async r => { if (r.method === "POST") { f.state.status = code === "INVITE_ALREADY_ACCEPTED" ? "accepted" : "revoked";f.state.revision = 1;if (code === "INVITE_ALREADY_REVOKED") f.state.revokedAt = "2026-10-27T12:00:00Z";return { status: 409, body: { error: { code, message: "private upstream fixture" } } }; }return f.respond(r); });fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));await screen.findByText(copy);expect(screen.queryByText("Invite revoked.")).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(1); }finally { f.close(); }
});
it("does not claim success when the canonical verification fails", async () => {
 const f = mount();try { await f.open();f.request.mockImplementation(async r => r.method === "POST" ? { status: 200, body: { inviteId: id, revision: 1, revokedAt: "2026-10-27T12:00:00Z" } } : r.path.endsWith("/" + id) ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "private details" } } } : f.respond(r));fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));await screen.findByText(/could not be verified/i);expect(screen.queryByText("Invite revoked.")).toBeNull();expect(screen.getByRole("button", { name: "Check current invite" })).toBeTruthy(); }finally { f.close(); }
});
for (const scope of ["org", "person"] as const) it(`ignores a late write result after a mounted ${scope} change`, async () => {
 const f = mount();try { await f.open();let resolve!: (r: ApiResponse) => void;const pending = new Promise<ApiResponse>(done => { resolve = done; });f.request.mockImplementation(async r => r.method === "POST" ? pending : f.respond(r));fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));if (scope === "org") f.me.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";else f.me.developer.id = "c".repeat(64);await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await screen.findByText("No pending invites on this page.");await act(async () => { resolve({ status: 200, body: { inviteId: id, revision: 1, revokedAt: "2026-10-27T12:00:00Z" } }); });expect(screen.queryByRole("dialog")).toBeNull();expect(screen.queryByText("Invite revoked.")).toBeNull();expect(f.query.getQueriesData({ queryKey: ["admin", "invites", orgId, developerId] })).toEqual([]); }finally { f.close(); }
});
it("returns focus to the page summary when a revoked row disappears", async () => {
 const f = mount();try { await f.open();fireEvent.click(screen.getByRole("button", { name: "Confirm revoke" }));await screen.findByText("Invite revoked.");await waitFor(() => expect(screen.queryByRole("table")).toBeNull());fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(document.activeElement).toBe(f.container.querySelector('[role="status"][tabindex="-1"]'))); }finally { f.close(); }
});
for (const theme of ["light", "dark"] as const) it(`has accessible revoke confirmation in ${theme}`, async () => { const f = mount({ theme });try { await f.open();await expectNoAxeViolations(screen.getByRole("dialog")); }finally { f.close(); } });

it("closes the selected invite and fails closed on a terminal list permission error", async () => {
 const f = mount();try { await f.open();f.request.mockImplementation(async r => r.path.includes("?limit=") ? { status: 403, body: { error: { code: "FORBIDDEN", message: "private fixture" } } } : f.respond(r));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "invites"] }); });await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(0); }finally { f.close(); }
});
it("keeps the dialog focus and blocks confirmation when its list becomes stale", async () => {
 const f = mount();try { await f.open();const confirm = screen.getByRole("button", { name: "Confirm revoke" });confirm.focus();f.request.mockImplementation(async r => r.path.includes("?limit=") ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "private fixture" } } } : f.respond(r));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "invites"] }); });await screen.findByText("Invite list is stale. Refresh it before confirming.");expect(document.activeElement).toBe(confirm);fireEvent.click(confirm);expect(f.request.mock.calls.filter(([r]) => r.method === "POST").length).toBe(0); }finally { f.close(); }
});
