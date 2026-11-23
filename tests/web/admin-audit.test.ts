// @vitest-environment jsdom
// The Audit page reads Cloud's company audit list (GET /v1/app/company/audit, plan v3.2 7.5), not the old broker's sealed ledger (/v1/app/org/audit/status and /records), which
// hosted Rovara does not serve (live test run 2, 2026-11-18: both 501). Every answer here is a REAL Cloud answer: the page's requests go through Cloud's own handler
// (createCloudHandler) with a fake Rovara Code behind it that answers as hosted Code 0.5.29 does (its audit read is a 404 "route not found" while sign-in client routes are off).
import { expect, it } from "vitest";
import { screen, waitFor, act, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
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



import { CodeClient, LocalCloudAuditStore, LocalSessionStore, LocalWorkSessionStore, createCloudHandler, type CloudAuditRecord, type CodeSession } from "@rovara/cloud-server";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const OWNER = "a".repeat(64), MEMBER = "b".repeat(64), OTHER = "c".repeat(64);
const PEOPLE: Record<string, { id: string; company: string; role: "owner" | "admin" | "member" }> = {
 "owner-token": { id: OWNER, company: A, role: "owner" }, "admin-token": { id: OWNER, company: A, role: "admin" }, "member-token": { id: MEMBER, company: A, role: "member" }, "other-token": { id: OTHER, company: B, role: "owner" },
};
const BASE = Date.UTC(2026, 10, 18, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;
const cloudRow = (companyId: string, atMs: number, action: CloudAuditRecord["action"]): CloudAuditRecord => ({ id: `aud_${String(n++).padStart(20, "0")}`, companyId, at: iso(atMs), actor: { developerId: OWNER, name: "Priya", type: "person" }, action, subject: "", outcome: "ok", via: "web" });
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Cloud's handler with company A's and company B's records, and a fake Code: hosted 0.5.29 answers its audit read 404 "route not found" unless `engine` gives records. */
async function cloud(options: { engine?: unknown[] } = {}) {
 const audit = new LocalCloudAuditStore(undefined, {});
 for (let i = 0; i < 60; i += 1) await audit.append(cloudRow(A, BASE - i * 60_000, i === 0 ? "company.rules.changed" : "company.invite.created"));
 await audit.append(cloudRow(B, BASE, "company.budget.changed"));
 const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input);
  const person = PEOPLE[((init?.headers as Record<string, string> | undefined)?.["authorization"] ?? "").replace(/^Bearer /u, "")];
  if (url.pathname === "/v1/auth/token") return jsonResponse(400, { error: "invalid_grant" });
  if (person === undefined) return jsonResponse(401, {});
  if (url.pathname === "/v1/dev/access") return jsonResponse(200, { developerId: person.id, displayName: "Priya", administrator: false, companyId: person.company, companyRole: person.role, projects: [], notices: [] });
  if (url.pathname === "/v1/dev/client/company/audit/records" && options.engine !== undefined) return jsonResponse(200, { records: options.engine });
  return jsonResponse(404, { error: { code: "NOT_FOUND", message: "route not found" } });
 }) as typeof fetch;
 const store = new LocalSessionStore(undefined, { environment: {} });
 const client = new CodeClient({ baseUrl: "https://code.example.test", clientId: "rovara-cloud", clientSecret: "secret", redirectUri: "http://127.0.0.1:8787/callback", scopes: "projects:members", fetch: fetchImpl });
 const handler = createCloudHandler({ client, store, work: new LocalWorkSessionStore(), origin: "https://cloud.example.test", org: { orgId: "rovara", name: "Rovara", plan: "test" }, callbackPath: "/callback", secureCookies: true, log: () => undefined, now: () => new Date(BASE + 3_600_000), audit });
 for (const token of Object.keys(PEOPLE)) {
  // The stored sign-in says owner of A for everyone: Cloud must go by Code's live answer.
  const access = { developerId: PEOPLE[token]!.id, displayName: "Priya", administrator: false, companyId: A, companyRole: "owner", projects: [], notices: [] } as CodeSession["access"];
  await store.create(`cookie-${token}`, { accessToken: token, refreshToken: `r-${token}`, csrf: "csrf", signedInAt: iso(BASE), access });
 }
 return async (token: string, path: string): Promise<ApiResponse> => {
  const url = new URL(path.replace(/^\/v1\/app\//u, "/v1/web/"), "https://cloud.example.test");
  const answer = await handler({ method: "GET", path: url.pathname, query: url.searchParams, headers: { cookie: `rovara_cloud_session=cookie-${token}`, "x-rovara-csrf": "csrf" } });
  return { status: answer!.status, body: JSON.parse(answer!.body) as unknown };
 };
}
async function audit(role: "owner" | "admin" = "owner", options: { engine?: unknown[] } = {}) {
 const cloudAs = await cloud(options);
 const me = { developer: { id: OWNER, name: "Priya", orgRole: role }, org: { orgId: A, name: "Acme", plan: "team" }, identities: [] };
 const f = mount({ path: "/app/admin/audit", role, respond: async r => r.path.startsWith("/v1/app/company/audit") || r.path.startsWith("/v1/app/org/audit") ? cloudAs(`${role}-token`, r.path) : { status: 200, body: r.path === "/v1/app/me" ? me : {} } });
 return { ...f, cloudAs };
}
const auditReads = (f: { request: { mock: { calls: Array<[ApiRequest]> } } }) => f.request.mock.calls.map(([r]) => r.path).filter(path => path.includes("audit"));

for (const role of ["owner", "admin"] as const) it(`${role}: reads Cloud's company audit list only (never the old ledger routes) and shows Cloud's records with the engine's plain status`, async () => {
 const f = await audit(role);
 await screen.findByRole("heading", { name: "Audit" });
 await screen.findByText("company.rules.changed");
 expect(screen.getByText("Engine records are not connected yet. This list shows Cloud's own records only.")).toBeTruthy();
 expect(auditReads(f).every(path => path.startsWith("/v1/app/company/audit?"))).toBe(true);
 expect(auditReads(f)).toHaveLength(1);
 // G1 SHIP copy: the rebuilt page names the source "Rovara web" (was "Rovara Cloud").
 expect(screen.getAllByText("Rovara web").length).toBeGreaterThan(0);
 // No sealing claim: this list is not a sealed ledger.
 expect(f.container.textContent).not.toMatch(/sealed|ledger|independent timestamp/i);
 expect(screen.queryByText(/Couldn't load|Not available/)).toBeNull();
 f.close();
});

it("another company's records never appear (Cloud's list is the caller's company from Code's live answer)", async () => {
 const f = await audit();
 await screen.findByText("company.rules.changed");
 expect(screen.queryByText("company.budget.changed")).toBeNull();
 expect(JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c", "audit"] }))).not.toContain("company.budget.changed");
 f.close();
});

it("Cloud refuses a member and answers another company's owner with that company's records only (the route's own negatives)", async () => {
 const cloudAs = await cloud();
 const member = await cloudAs("member-token", "/v1/app/company/audit?limit=50");
 expect(member.status).toBe(403);
 expect(JSON.stringify(member.body)).not.toContain("company.");
 const other = await cloudAs("other-token", "/v1/app/company/audit?limit=50");
 expect(other.status).toBe(200);
 expect((other.body as { records: Array<{ action: string }> }).records.map(row => row.action)).toEqual(["company.budget.changed"]);
 // The old ledger routes are not Cloud's: they answer Cloud's fixed 501.
 expect((await cloudAs("owner-token", "/v1/app/org/audit/status")).status).toBe(501);
});

it("an ordinary member's page makes no audit read", async () => {
 const cloudAs = await cloud();
 const me = { developer: { id: MEMBER, name: "Maya", orgRole: "member" }, org: { orgId: A, name: "Acme", plan: "team" }, identities: [] };
 const f = mount({ path: "/app/admin/audit", role: "member", respond: async r => r.path.includes("audit") ? cloudAs("member-token", r.path) : { status: 200, body: r.path === "/v1/app/me" ? me : {} } });
 await screen.findByRole("heading", { name: "Administration unavailable" });
 expect(auditReads(f)).toHaveLength(0);
 f.close();
});

it("shows the engine's records when Code serves them, marked as Rovara Code's", async () => {
 const f = await audit("owner", { engine: [{ eventId: "ev_0001", at: iso(BASE + 60_000), actor: { developerId: OWNER, name: "Grace", type: "person" }, action: "task.approved", subject: "task:t1", outcome: "ok", via: "slack" }] });
 await screen.findByText("task.approved");
 // G1 SHIP copy: "Rovara’s task engine" (was "Rovara Code"); it now names the source in the rail AND in the row (2 places, was 1).
 expect(screen.getAllByText("Rovara’s task engine").length).toBe(2);
 expect(screen.queryByText(/Engine records are not connected yet/)).toBeNull();
 f.close();
});

it("pages with Cloud's cursor and goes back to the first page", async () => {
 const f = await audit();
 await screen.findByText("company.rules.changed");
 expect(screen.getByRole("status", { name: "Audit records shown on this page" }).textContent).toBe("Page 1: 50 records, up to 50 per page.");
 fireEvent.click(screen.getByRole("button", { name: "Next page" }));
 await waitFor(() => expect(screen.getByRole("status", { name: "Audit records shown on this page" }).textContent).toBe("Page 2: 10 records, up to 50 per page."));
 expect(auditReads(f)[1]).toContain("cursor=");
 expect(screen.queryByText("company.rules.changed")).toBeNull();
 expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
 await screen.findByText("company.rules.changed");
 expect(auditReads(f).slice(2).every(path => !path.includes("cursor="))).toBe(true);
 f.close();
});

it("applies a valid UTC range on submit (Cloud's own query shape) and refuses a reversed one without a read", async () => {
 const f = await audit();
 await screen.findByText("company.rules.changed");
 fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-11-18T11:00" } });
 fireEvent.change(screen.getByLabelText("Through (UTC)"), { target: { value: "2026-11-18T11:30" } });
 fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
 await waitFor(() => expect(auditReads(f)).toHaveLength(2));
 const sent = new URL(auditReads(f)[1]!, "https://x.test").searchParams;
 expect(sent.get("from")).toBe("2026-11-18T11:00:00.000Z");
 expect(sent.get("to")).toBe("2026-11-18T11:30:00.000Z");
 await waitFor(() => expect(screen.getByRole("status", { name: "Audit records shown on this page" }).textContent).toBe("Page 1: 30 records, up to 50 per page."));
 fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-11-18T12:00" } });
 fireEvent.change(screen.getByLabelText("Through (UTC)"), { target: { value: "2026-11-18T11:00" } });
 fireEvent.click(screen.getByRole("button", { name: "Apply range" }));
 await screen.findByText("From must be no later than Through.");
 expect(auditReads(f)).toHaveLength(2);
 f.close();
});

it("does not read again on focus or reconnect", async () => {
 const f = await audit();
 await screen.findByText("company.rules.changed");
 const before = auditReads(f).length;
 await act(async () => { focusManager.setFocused(false); onlineManager.setOnline(false); onlineManager.setOnline(true); focusManager.setFocused(true); await new Promise(r => setTimeout(r, 30)); });
 expect(auditReads(f)).toHaveLength(before);
 f.close();
});

it("a next cursor that names the page just read is refused (no page loop)", async () => {
 const cloudAs = await cloud();
 const me = { developer: { id: OWNER, name: "Priya", orgRole: "owner" }, org: { orgId: A, name: "Acme", plan: "team" }, identities: [] };
 let firstNext = "";
 const f = mount({ path: "/app/admin/audit", role: "owner", respond: async r => {
  if (!r.path.startsWith("/v1/app/company/audit")) return { status: 200, body: r.path === "/v1/app/me" ? me : {} };
  const real = await cloudAs("owner-token", r.path);
  const body = real.body as { next?: string; records: Array<{ action: string }> };
  if (!r.path.includes("cursor=")) { firstNext = body.next ?? ""; return real; }
  return { status: 200, body: { ...body, next: firstNext, records: [{ ...body.records[0]!, action: "company.rules.changed" }] } };
 } });
 await screen.findByText("company.rules.changed");
 fireEvent.click(screen.getByRole("button", { name: "Next page" }));
 // G1 SHIP copy: the shared 4e error block (was "This information is unavailable. Reload or try again.").
 await screen.findByText("Rovara couldn't read this page");
 f.close();
});

it("an answer that does not read (unknown source) is refused before it is shown or cached", async () => {
 const cloudAs = await cloud();
 const me = { developer: { id: OWNER, name: "Priya", orgRole: "owner" }, org: { orgId: A, name: "Acme", plan: "team" }, identities: [] };
 const f = mount({ path: "/app/admin/audit", role: "owner", respond: async r => {
  if (!r.path.startsWith("/v1/app/company/audit")) return { status: 200, body: r.path === "/v1/app/me" ? me : {} };
  const real = await cloudAs("owner-token", r.path) as { status: number; body: { records: Array<Record<string, unknown>> } };
  return { status: 200, body: { ...real.body, records: [{ ...real.body.records[0], source: "elsewhere", action: "forged.action" }] } };
 } });
 // G1 SHIP copy: the shared 4e error block (was "This information is unavailable. Reload or try again.").
 await screen.findByText("Rovara couldn't read this page");
 expect(screen.queryByText("forged.action")).toBeNull();
 expect(JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c", "audit"] }))).not.toContain("forged.action");
 f.close();
});
