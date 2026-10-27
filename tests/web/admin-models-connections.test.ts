// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, waitFor, act, fireEvent, within } from "@testing-library/react";
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


import type { ApiRequest, ApiResponse } from "../../packages/ui/src/host.js";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const member = { developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" };
function mount(options: { path?: string; role?: "owner" | "admin" | "member"; theme?: "light" | "dark"; enabled?: boolean; kind?: "web" | "desktop"; state?: unknown; width?: number; respond?: (r: ApiRequest) => Promise<ApiResponse> } = {}) {
 const role = options.role ?? "owner", nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { ...features, admin: options.enabled ?? true } });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => options.respond?.(r) ?? { status: 200, body: r.path === "/v1/app/nav" ? nav : r.path === "/v1/app/me" ? me : r.path === "/v1/app/home" ? { cards: [], total: 0 } : { members: [member] } });
 f.host.kind = options.kind ?? "web";
 f.host.viewport = { width: () => options.width ?? 1280, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [{ pathname: options.path ?? "/app/admin/people", state: options.state }] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, query, router, me, close: () => { view.unmount();router.dispose();query.clear(); } };
}

const source = { sourceId: "src_aaaaaaaaaaaaaaaaaaaa", kind: "openai", label: "Company source", hasCredential: true, inOrder: true, models: [{ catalog: { provider: "openai", modelId: "sample-model" } }], apiKey: "synthetic-private-value", suffix: "private-suffix", roleArn: "private-role" };
const bodies: Record<string, unknown> = {
 "/v1/app/models": { models: [{ provider: "openai", modelId: "builtin-model", label: "Builtin", company: "openai", sources: ["rovara", "personal-chatgpt"] }] },
 "/v1/app/org/model-sources": { sources: [source], order: ["personal-chatgpt", "rovara", source.sourceId] },
 "/v1/app/connections": { connections: [{ connectionId: "con_aaaaaaaaaaaaaaaaaaaa", type: "linear", label: "Tracker", identity: "service", hasCredential: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z", lastCheck: { ok: true, at: "2026-10-02T00:00:00Z", message: "synthetic-private-value" } }] },
 "/v1/app/github/requests": { requests: [{ githubLogin: "requester", status: "waiting", requestedAt: "2026-10-01T00:00:00Z", accountLogin: "Pending organization" }] },
 "/v1/app/github/installations": { installations: [{ installationId: 7, accountLogin: "Example", status: "suspended" }] },
 "/v1/app/approvals?status=PENDING": { approvals: [{ approvalId: "approval-one", kind: "step", status: "PENDING", createdAt: "2026-10-01T00:00:00Z", confirmUrl: "https://evil.example/steal", prompt: "synthetic-private-value" }] },
 "/v1/app/spend-requests": { spendRequests: [] },
};
function area(path: string) { return mount({ path, respond: async r => ({ status: 200, body: bodies[r.path] ?? (r.path === "/v1/app/me" ? AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] }) : {}) }) }); }
for (const [path, title, content] of [["models/sources", "AI models", "Company source"], ["models/available", "Available models", "sample-model"], ["models/steps", "Code step models", "Effective model unavailable"], ["connections", "Connections", "Tracker"], ["waiting", "Waiting for people", "Approval"]] as const) it(`opens ${path} read-only with safe projected data`, async () => {
 const f = area("/app/admin/" + path);await screen.findByRole("heading", { name: title });await screen.findAllByText(content, { exact: false });
 expect(f.container.textContent).not.toContain("synthetic-private-value");expect(f.container.textContent).not.toContain("private-suffix");expect(f.container.querySelector('a[href*="evil.example"]')).toBeNull();
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);expect(JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] }))).not.toContain("synthetic-private-value");f.close();
});
it("does not claim configured models are verified or invent prices", async () => { const f = area("/app/admin/models/available");await screen.findByText("sample-model");expect(screen.getAllByText(/Unverified/).length).toBeGreaterThan(0);expect(screen.getByText(/Cost unavailable/)).toBeTruthy();f.close(); });
it("keeps successful connection sections when one read fails", async () => { const f = area("/app/admin/connections");await screen.findByText("Tracker");f.request.mockImplementation(async r => r.path === "/v1/app/connections" ? { status: 403, body: {} } : { status: 200, body: bodies[r.path] });await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "lane-c"] }); });expect(await screen.findByText(/permission to view/)).toBeTruthy();expect(screen.queryByText("Tracker")).toBeNull();expect(screen.getByText("Example")).toBeTruthy();f.close(); });
it("states waiting coverage and never mints confirmation tickets", async () => { const f = area("/app/admin/waiting");await screen.findByText("Approval");expect(screen.getByText(/Questions, plan reviews/)).toBeTruthy();expect(f.request.mock.calls.some(([r]) => r.path.includes("confirm-link"))).toBe(false);f.close(); });
for (const field of ["org", "developer"] as const) it(`evicts old ${field} data and fetches the new identity scope`, async () => {
 const f = area("/app/admin/models/sources");await screen.findAllByText("Company source");const next = structuredClone(f.me);if (field === "org") next.org.orgId = "org_bbbbbbbbbbbbbbbbbbbb";else next.developer.id = "b".repeat(64);
 let resolve!: (v: ApiResponse) => void;const pending = new Promise<ApiResponse>(r => { resolve = r; });f.request.mockImplementation(async r => r.path === "/v1/app/me" ? { status: 200, body: next } : pending);
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await waitFor(() => expect(screen.queryAllByText("Company source")).toEqual([]));
 expect(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] }).every(([key]) => key.includes(next.org.orgId) && key.includes(next.developer.id))).toBe(true);
 await act(async () => resolve({ status: 200, body: { sources: [], order: ["rovara"] } }));await screen.findByText(/No company sources/);f.close();
});
it("removes all lane C cache after role revocation", async () => { const f = area("/app/admin/models/sources");await screen.findAllByText("Company source");const next = structuredClone(f.me);next.developer.orgRole = "member";f.request.mockImplementation(async () => ({ status: 200, body: next }));await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await screen.findByRole("heading", { name: "Administration unavailable" });await waitFor(() => expect(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] })).toEqual([]));f.close(); });

for (const role of ["owner", "admin", "member"] as const) it(`preserves the authorized waiting queue for ${role}`, async () => {
 const f = mount({ path: "/app/admin/waiting", role, respond: async r => ({ status: 200, body: r.path === "/v1/app/me" ? { developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } : bodies[r.path] ?? {} }) });
 await screen.findByRole("heading", { name: "Waiting for people" });await screen.findByText("Approval");if (role === "member") { expect(screen.queryByRole("link", { name: "AI models" })).toBeNull();expect(f.request.mock.calls.some(([r]) => r.path === "/v1/app/org/model-sources")).toBe(false); }f.close();
});

it("shows pending GitHub install requests separately from installed health", async () => { const f = area("/app/admin/connections");await screen.findByText(/Pending organization/);expect(screen.getByText(/Waiting for GitHub admin/)).toBeTruthy();f.close(); });
it("preserves the exact Bedrock warning and strips setup identities", async () => {
 const f = mount({ path: "/app/admin/models/sources", respond: async r => ({ status: 200, body: r.path.endsWith("model-sources") ? { sources: [{ ...source, kind: "bedrock", externalId: "synthetic-private-value" }], order: [] } : { developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } }) });
 await screen.findByText(/NOT TESTED: Bedrock in your own AWS account hasn't been tested yet./);expect(JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] }))).not.toContain("externalId");f.close();
});

it("keeps waiting reachable with a member's real navigation projection", async () => {
 const f = mount({ path: "/app/admin/waiting", role: "member", enabled: false, respond: async r => ({ status: 200, body: r.path === "/v1/app/me" ? { developer: { id: "a".repeat(64), name: "Priya", orgRole: "member" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } : bodies[r.path] ?? {} }) });
 await screen.findByRole("heading", { name: "Waiting for people" });expect(screen.getAllByRole("link", { name: "Waiting for people" }).length).toBeGreaterThan(0);expect(screen.queryByRole("link", { name: "AI models" })).toBeNull();f.close();
});

it("rechecks waiting permissions on same-person admin demotion without retaining admin rows", async () => {
 const f = area("/app/admin/waiting");await screen.findByText("Approval");const next = structuredClone(f.me);next.developer.orgRole = "member";
 let resolve!: (v: ApiResponse) => void;const pending = new Promise<ApiResponse>(r => { resolve = r; });f.request.mockImplementation(async r => r.path.endsWith("/me") ? { status: 200, body: next } : pending);
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "identity"] }); });await waitFor(() => expect(screen.queryByText("Approval")).toBeNull());
 await act(async () => resolve({ status: 200, body: { approvals: [], spendRequests: [] } }));await screen.findAllByText("No pending items visible to you in this list and filter.");f.close();
});

it("opens only safe bare same-origin confirmation links and drops private queue fields", async () => {
 const urls = ["https://cell.example/v1/app/approve/apr_safe", "https://other.example/v1/app/approve/apr_other", "javascript:alert(1)", "https://cell.example/v1/app/approve/apr_ticket?ticket=unsafe", "https://cell.example/v1/app/approve/apr_fragment#x", "https://cell.example/settings"];
 const f = mount({ path: "/app/admin/waiting", respond: async r => ({ status: 200, body: r.path.includes("/approvals?") ? { approvals: urls.map((confirmUrl, i) => ({ approvalId: `approval-${i}`, status: "PENDING", kind: "step", createdAt: "2026-10-01T00:00:00Z", confirmUrl, prompt: "unneeded private content", email: "synthetic@example.test" })) } : r.path.endsWith("/spend-requests") ? { spendRequests: [] } : { developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } }) });
 const buttons = await screen.findAllByRole("button", { name: "Open confirmation" });expect(buttons).toHaveLength(1);expect(f.host.openExternal).not.toHaveBeenCalled();expect(screen.queryByRole("link", { name: "Open confirmation" })).toBeNull();fireEvent.click(buttons[0]!);expect(f.host.openExternal).toHaveBeenCalledExactlyOnceWith(urls[0]);
 const cache = JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] }));expect(cache).not.toContain("unneeded private content");expect(cache).not.toContain("synthetic@example.test");expect(cache).not.toContain("other.example");expect(cache).not.toContain("ticket=unsafe");f.close();
});
it("keeps working connection data mounted but marks a failed background refresh stale", async () => {
 const f = area("/app/admin/connections");await screen.findByText("Tracker");f.request.mockImplementation(async r => r.path === "/v1/app/connections" ? { status: 400, body: { error: { code: "CONFIG_INVALID", message: "untrusted provider error" } } } : { status: 200, body: bodies[r.path] });
 await act(async () => { await f.query.invalidateQueries({ queryKey: ["admin", "lane-c", "connections"] }); });expect(screen.getByText("Tracker")).toBeTruthy();expect(await screen.findByText(/information is stale/)).toBeTruthy();expect(screen.queryByText("untrusted provider error")).toBeNull();f.close();
});
it("keeps waiting focus and rows during a successful background recheck", async () => {
 const f = area("/app/admin/waiting");await screen.findByText("Approval");const select = screen.getByRole("combobox", { name: "Kind" });select.focus();let resolve!: (v: ApiResponse) => void;const pending = new Promise<ApiResponse>(r => { resolve = r; });
 f.request.mockImplementation(async r => r.path.includes("/approvals?") ? pending : { status: 200, body: bodies[r.path] });let refresh!: Promise<unknown>;
 await act(async () => { refresh = f.query.invalidateQueries({ queryKey: ["admin", "lane-c", "approvals"] });await new Promise(r => setTimeout(r, 20)); });expect(screen.getByText("Approval")).toBeTruthy();expect(document.activeElement).toBe(select);
 await act(async () => { resolve({ status: 200, body: bodies["/v1/app/approvals?status=PENDING"] });await refresh; });expect(document.activeElement).toBe(select);f.close();
});

it("shows declared connection account association without exposing an account identity", async () => { const f = area("/app/admin/connections");await screen.findByText("Tracker");expect(screen.getByText("Service account (declared)")).toBeTruthy();f.close(); });

it("reads the permitted serving catalog independently of unavailable company sources", async () => {
 const f = mount({ path: "/app/admin/models/available", respond: async r => r.path.endsWith("/model-sources") ? { status: 403, body: {} } : { status: 200, body: r.path === "/v1/app/models" ? bodies[r.path] : { developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } } });
 await screen.findByText("builtin-model");expect(screen.getByText("Rovara, Personal ChatGPT")).toBeTruthy();expect(screen.getByText(/permission to view/)).toBeTruthy();expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});

it("keeps filtered waiting counts consistent with visible rows", async () => {
 const f = area("/app/admin/waiting");await screen.findByText("Approval");const approvals = screen.getByRole("region", { name: "Approvals" });
 expect(within(approvals).getByText("1 of 1 shown in this list.")).toBeTruthy();fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "spend" } });
 expect(within(approvals).getByText("0 of 1 shown in this list.")).toBeTruthy();expect(within(approvals).queryByText("Approval")).toBeNull();fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "all" } });expect(within(approvals).getByText("1 of 1 shown in this list.")).toBeTruthy();f.close();
});
it("hides the waiting navigation link below the supported viewport", async () => {
 const f = mount({ path: "/app", role: "member", enabled: false, width: 390 });await screen.findByRole("heading", { name: "Home" });expect(screen.queryByRole("link", { name: "Waiting for people" })).toBeNull();f.close();
});
it("normalizes configured and serving Bedrock providers at the same cache boundary", async () => {
 const f = mount({ path: "/app/admin/models/available", respond: async r => ({ status: 200, body: r.path.endsWith("/model-sources") ? { sources: [{ ...source, kind: "bedrock", models: [{ catalog: { provider: "amazon-bedrock", modelId: "bedrock-sample" } }] }], order: [] } : r.path === "/v1/app/models" ? { models: [{ provider: "amazon-bedrock", modelId: "served-bedrock-sample", sources: [source.sourceId] }] } : { developer: { id: "a".repeat(64), name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] } }) });
 await screen.findByText("bedrock-sample");await screen.findByText("served-bedrock-sample");const cache=JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c"] }));expect(cache).not.toContain("amazon-bedrock");expect(cache.match(/"provider":"bedrock"/g)).toHaveLength(2);f.close();
});
