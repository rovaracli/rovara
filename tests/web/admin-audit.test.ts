// @vitest-environment jsdom
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


const orgId = "org_aaaaaaaaaaaaaaaaaaaa";
const ledgerStatus = { headSeq: 3, sealedThroughSeq: 2, latestTimestamp: "2026-10-01T00:00:00Z", epochsWithoutTimestamp: ["epoch-one"], lockMode: "GOVERNANCE" };
const limits = ["What this ledger proves: the records in this export have not been changed, removed or reordered since Rovara sealed them, and each sealed batch existed no later than the time an independent timestamp service signed.", "What it does not prove: that the records are true or complete. Rovara writes them, so an action Rovara never recorded, or recorded wrongly, does not show up as tampering. Records after the last seal are not sealed yet; this export says how many.", "It is tamper-evident, not tamper-proof. Someone with enough access could still change Rovara's live copy, but the change would show when checked against the sealed copy, the timestamps and your earlier exports. Keep every export you take."].join("\n\n");
const row = { record: { orgId, seq: 1, action: "member.role_changed", occurredAt: "2026-10-01T00:00:00Z", recordedAt: "2026-10-01T00:00:01Z", actor: { kind: "member", id: "actor-pseudonym" }, target: { kind: "member", id: "target-pseudonym" }, proof: { kind: "browser", sessionRef: "unneeded-session-ref" }, facts: { unknownSecret: "synthetic-private-value" } }, details: [{ subject: "person", salt: "unneeded-salt", fields: { email: "synthetic@example.test", apiKey: "synthetic-private-value" } }] };
function page(cursor = false) { return { ...ledgerStatus, records: [{ ...row, record: { ...row.record, seq: cursor ? 2 : 1, action: cursor ? "org.renamed" : "member.role_changed" } }], ...(cursor ? {} : { nextCursor: "next_page" }) }; }
function audit(role: "owner" | "admin" | "member" = "owner") { return mount({ path: "/app/admin/audit", role, respond: async r => ({ status: 200, body: r.path === "/v1/app/me" ? { developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] } : r.path.includes("/audit/status") ? { ...ledgerStatus, limits } : r.path.includes("/audit/records") ? page(r.path.includes("cursor=")) : {} }) }); }
for (const role of ["owner", "admin"] as const) it(`opens the audit metadata for ${role} with exact limits and safe projections`, async () => {
 const f = audit(role);await screen.findByRole("heading", { name: "Audit" });await screen.findByText("member.role_changed");expect(screen.getByText("1 unsealed record")).toBeTruthy();expect(screen.getByText("In governance mode, a privileged administrator could remove the sealed copies.")).toBeTruthy();
 for (const part of limits.split("\n\n")) expect(screen.getByText(part)).toBeTruthy();const cache=JSON.stringify(f.query.getQueriesData({ queryKey: ["admin", "lane-c", "audit"] }));for (const text of ["synthetic-private-value", "synthetic@example.test", "unneeded-salt", "unneeded-session-ref"]) { expect(cache).not.toContain(text);expect(f.container.textContent).not.toContain(text); }expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);f.close();
});
it("makes no audit read for an ordinary member", async () => { const f=audit("member");await screen.findByRole("heading", { name: "Administration unavailable" });expect(f.request.mock.calls.some(([r]) => r.path.includes("/audit/"))).toBe(false);f.close(); });
it("does not refetch audit records or status on focus, reconnect or identity recheck", async () => {
 const f=audit();await screen.findByText("member.role_changed");const count=()=>f.request.mock.calls.filter(([r])=>r.path.includes("/audit/")).length;const before=count();
 await act(async()=>{focusManager.setFocused(false);onlineManager.setOnline(false);onlineManager.setOnline(true);focusManager.setFocused(true);await f.query.invalidateQueries({queryKey:["admin","identity"]});await new Promise(r=>setTimeout(r,30));});expect(count()).toBe(before);expect(screen.getByText("member.role_changed")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Refresh this page and status"}));await waitFor(()=>expect(count()).toBe(before+2));f.close();
});
it("reads only the requested page and uses server cursors on deliberate pagination", async()=>{
 const f=audit();await screen.findByText("member.role_changed");expect(f.request.mock.calls.filter(([r])=>r.path.includes("/audit/records"))).toHaveLength(1);fireEvent.click(screen.getByRole("button",{name:"Next page"}));await screen.findByText("org.renamed");expect(screen.queryByText("member.role_changed")).toBeNull();expect(f.request.mock.calls.filter(([r])=>r.path.includes("/audit/records"))).toHaveLength(2);expect(f.request.mock.calls.some(([r])=>new URL(r.path,"https://cell.example").searchParams.get("cursor")==="next_page")).toBe(true);f.close();
});
it("applies valid UTC filters only on submit and resets pagination",async()=>{
 const f=audit();await screen.findByText("member.role_changed");const before=f.request.mock.calls.length;fireEvent.change(screen.getByLabelText("From (UTC)"),{target:{value:"2026-10-01T12:30"}});fireEvent.change(screen.getByLabelText("Through (UTC)"),{target:{value:"2026-10-02T12:30"}});expect(f.request.mock.calls).toHaveLength(before);fireEvent.click(screen.getByRole("button",{name:"Apply time range"}));await waitFor(()=>expect(f.request.mock.calls.some(([r])=>new URL(r.path,"https://cell.example").searchParams.get("from")==="2026-10-01T12:30:00.000Z")).toBe(true));expect(f.request.mock.calls.filter(([r])=>r.path.includes("/audit/records")).at(-1)?.[0].path).not.toContain("cursor=");f.close();
});
it("rejects reversed time ranges without a read",async()=>{
 const f=audit();await screen.findByText("member.role_changed");const before=f.request.mock.calls.length;fireEvent.change(screen.getByLabelText("From (UTC)"),{target:{value:"2026-10-02T12:30"}});fireEvent.change(screen.getByLabelText("Through (UTC)"),{target:{value:"2026-10-01T12:30"}});fireEvent.click(screen.getByRole("button",{name:"Apply time range"}));expect(await screen.findByText("From must be no later than Through.")).toBeTruthy();expect(f.request.mock.calls).toHaveLength(before);f.close();
});
it("keeps independent status information when record access fails and hides old rows",async()=>{
 const f=audit();await screen.findByText("member.role_changed");f.request.mockImplementation(async r=>r.path.includes("/audit/records")?{status:403,body:{error:{code:"FORBIDDEN",message:"untrusted detail"}}}:{status:200,body:{...ledgerStatus,limits}});fireEvent.click(screen.getByRole("button",{name:"Refresh this page and status"}));await screen.findByText(/permission to view/);expect(screen.queryByText("member.role_changed")).toBeNull();expect(screen.getByText("1 unsealed record")).toBeTruthy();expect(screen.queryByText("untrusted detail")).toBeNull();f.close();
});
it("rejects a foreign-org record before caching",async()=>{
 const f=audit();await screen.findByText("member.role_changed");f.request.mockImplementation(async r=>({status:200,body:r.path.includes("/audit/records")?{...page(),records:[{...row,record:{...row.record,orgId:"org_bbbbbbbbbbbbbbbbbbbb",action:"foreign-action"}}]}:{...ledgerStatus,limits}}));fireEvent.click(screen.getByRole("button",{name:"Refresh this page and status"}));await screen.findByText("This information is unavailable. Reload or try again.");expect(screen.queryByText("foreign-action")).toBeNull();expect(JSON.stringify(f.query.getQueriesData({queryKey:["admin","lane-c","audit"]}))).not.toContain("foreign-action");f.close();
});
for (const field of ["org","developer"] as const) it(`evicts old audit pages and resets cursors when ${field} changes`,async()=>{
 const f=audit();await screen.findByText("member.role_changed");fireEvent.click(screen.getByRole("button",{name:"Next page"}));await screen.findByText("org.renamed");const next=structuredClone(f.me);if(field==="org")next.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";else next.developer.id="b".repeat(64);
 let resolve!:(v:ApiResponse)=>void;const pending=new Promise<ApiResponse>(r=>{resolve=r;});const paths:string[]=[];f.request.mockImplementation(async r=>{if(r.path.endsWith("/me"))return{status:200,body:next};paths.push(r.path);return pending;});await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.queryByText("org.renamed")).toBeNull());expect(paths.filter(path=>path.includes("/audit/records")).every(path=>!path.includes("cursor="))).toBe(true);expect(f.query.getQueriesData({queryKey:["admin","lane-c","audit"]}).every(([key])=>key.includes(next.org.orgId)&&key.includes(next.developer.id))).toBe(true);await act(async()=>resolve({status:200,body:{...ledgerStatus,limits,records:[]}}));f.close();
});
it("clears audit data on role revocation",async()=>{
 const f=audit();await screen.findByText("member.role_changed");const next=structuredClone(f.me);next.developer.orgRole="member";f.request.mockImplementation(async()=>({status:200,body:next}));await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await screen.findByRole("heading",{name:"Administration unavailable"});await waitFor(()=>expect(f.query.getQueriesData({queryKey:["admin","lane-c","audit"]})).toEqual([]));f.close();
});

it("distinguishes an empty filtered page from unavailable or unsealed history",async()=>{
 const f=audit();await screen.findByText("member.role_changed");f.request.mockImplementation(async()=>({status:200,body:{...ledgerStatus,limits,records:[]}}));fireEvent.click(screen.getByRole("button",{name:"Refresh this page and status"}));expect(await screen.findByText("No audit records returned for this page and time range. This does not prove no action occurred.")).toBeTruthy();expect(screen.getByText("1 unsealed record")).toBeTruthy();f.close();
});
it("marks failed background records stale without hiding the last good page",async()=>{
 const f=audit();await screen.findByText("member.role_changed");f.request.mockImplementation(async r=>r.path.includes("/audit/records")?{status:400,body:{error:{code:"CONFIG_INVALID",message:"untrusted storage response"}}}:{status:200,body:{...ledgerStatus,limits}});fireEvent.click(screen.getByRole("button",{name:"Refresh this page and status"}));await screen.findByText(/information is stale/);expect(screen.getByText("member.role_changed")).toBeTruthy();expect(screen.queryByText("untrusted storage response")).toBeNull();expect(screen.getByRole("button",{name:"Next page"})).toHaveProperty("disabled",true);f.close();
});
