// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { navFixture, meFixture } from "./support/fixtures.js";
import { projectFixture } from "./support/project-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
const project = { name: "payments", description: "Payment service", status: "active", latestRevision: 3, repositories: [{ fullName: "Acme/payments", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: ["sensitive command"], testCommands: ["sensitive test"], devcontainer: null, allowedDomains: [{ domain: "docs.example.com", status: "pending" }] }, createdAt: "2026-10-01T00:00:00Z", createdBy: { developerId: "a".repeat(64), name: "Priya" } };
const agent = { agentId: "rovara-code", name: "Rovara Code", description: "Build code", builtin: true, status: "active", access: "edit", latestVersion: 2, pinnedVersion: 1, monthlyBudgetUsd: 0 };
const guardrails = { maxAutonomy: "prepare", forbiddenModels: [], requireCrossCompanyReview: true, maxAgentMonthlyUsd: 100, maxPerRunCeilingUsd: 10, disabledBuiltins: [], extraTriggerLabels: [], extraCommandWords: [], reportLinkDomains: [] };
function mount(path = "/app/admin/projects", options: {role?:string; respond?:(r:ApiRequest)=>Promise<ApiResponse>; theme?:string; shipped?:boolean} = {}) {
 const me = meFixture();me.developer.orgRole = (options.role ?? "owner") as typeof me.developer.orgRole;
 const nav = navFixture({ me: { developerId: me.developer.id, name: "Priya", orgRole: options.role==="member"?"member":"owner" }, features: { localAgents:false, admin:true, usage:false, chains:false, describe:false, notices:false } });
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status:200, body:structuredClone(me) };
  if (r.path === "/v1/app/nav") return { status:200, body:nav };
  if (options.respond) return options.respond(r);
  return { status:200, body:r.path.includes("/versions") ? { versions:[{version:1,current:true},{version:2,safety:"unknown"}] } : r.path.includes("agent-guardrails") ? {guardrails,revision:1} : r.path.includes("/agents?") ? {agents:[agent]} : r.path.endsWith("/members") ? {members:[{developerId:"b".repeat(64),name:"Maya",role:"contributor",source:"grant",email:"synthetic@example.test"}]} : r.path === "/v1/app/projects/payments" ? project : {projects:[project,{...project,name:"old",status:"archived"}]} };
 });
 const query = createQueryClient();query.setQueryData(["nav"],nav);f.storage.set("rovara.theme",options.theme??"light");
 const routes=appRoutes(nav.features);if(!options.shipped){const admin=routes.find(r=>r.path==="/app")!.children!.find(r=>r.path==="admin/*")!;admin.children!.unshift({path:"agents",lazy:async()=>({Component:(await import("../../packages/ui/src/screens/admin/agents/AgentsScreen.js")).AgentsScreen})},{path:"agents/:id/versions",lazy:async()=>({Component:(await import("../../packages/ui/src/screens/admin/agents/AgentVersionsScreen.js")).AgentVersionsScreen})});}const router = createMemoryRouter(routes,{initialEntries:[path]});
 const view = renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));
 return {...f,...view,me,query,router,close(){view.unmount();router.dispose();query.clear();}};
}
for(const role of ["owner","admin"]) it(`shows read-only projects for ${role} and preserves list filters through detail`,async()=>{
 const f=mount("/app/admin/projects",{role});await screen.findByRole("table",{name:"Projects"});expect(screen.queryByRole("link",{name:"old"})).toBeNull();
 fireEvent.change(screen.getByRole("searchbox",{name:"Find in this project list"}),{target:{value:"payment"}});fireEvent.click(screen.getAllByRole("link",{name:"payments"}).find(a=>a.getAttribute("href")?.startsWith("/app/admin/projects/"))!);
 await screen.findByRole("heading",{name:"payments"});await screen.findByText("Maya");expect(screen.getByText("Using GitHub default branch")).toBeTruthy();expect(screen.getByText("Project grant")).toBeTruthy();
 expect(f.container.textContent).not.toContain("sensitive command");expect(JSON.stringify(f.query.getQueriesData({queryKey:["admin","project-members"]}))).not.toContain("synthetic@example.test");
 fireEvent.click(screen.getByRole("link",{name:"Back to projects"}));await screen.findByRole("searchbox");expect(screen.getByRole("searchbox")).toHaveProperty("value","payment");expect(f.request.mock.calls.every(([r])=>r.method==="GET")).toBe(true);f.close();
});
for(const role of ["member","maintainer","viewer","future-role"]) for(const path of ["projects","agents"]) it(`refuses ${role} at ${path} without area reads`,async()=>{
 const f=mount("/app/admin/"+path,{role});await screen.findByRole("heading",{name:"Administration unavailable"});expect(f.request.mock.calls.some(([r])=>r.path.includes("/projects")||r.path.includes("/agents"))).toBe(false);f.close();
});
it("shows visible agent pins, versions and guardrails without write controls",async()=>{
 const f=mount("/app/admin/agents");await screen.findByRole("table",{name:"Visible agents"});expect(screen.getByText("Visible agents only; this is not a complete company adoption inventory.")).toBeTruthy();expect(screen.getByText("Maximum autonomy: prepare")).toBeTruthy();
 expect(screen.queryByRole("button",{name:/Adopt|Save|Publish/})).toBeNull();fireEvent.click(screen.getByRole("link",{name:"Versions for Rovara Code"}));await screen.findByRole("table",{name:"Agent versions"});expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);expect(f.request.mock.calls.every(([r])=>r.method==="GET")).toBe(true);f.close();
});
for(const area of ["projects","agents"]) it(`clears ${area} after access revocation`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");f.me.developer.orgRole="member";await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await screen.findByRole("heading",{name:"Administration unavailable"});await waitFor(()=>expect(screen.queryByRole("table")).toBeNull());await waitFor(()=>expect(f.query.getQueriesData({queryKey:["admin",area]})).toEqual([]));f.close();
});
for(const field of ["org","developer"]) for(const area of ["projects","agents"]) it(`isolates ${area} on ${field} change`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");const oldOrg=f.me.org.orgId,oldPerson=f.me.developer.id;
 if(field==="org")f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";else f.me.developer.id="c".repeat(64);
 let resolve!:(r:ApiResponse)=>void;const delayed=new Promise<ApiResponse>(r=>{resolve=r;});f.request.mockImplementation(async r=>r.path.endsWith("/me")?{status:200,body:structuredClone(f.me)}:delayed);
 await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.queryByRole("table")).toBeNull());await waitFor(()=>expect(f.query.getQueryData(["admin",area,oldOrg,oldPerson,"list"])).toBeUndefined());
 await act(async()=>resolve({status:200,body:area==="projects"?{projects:[]}:{agents:[]}}));f.close();
});
for(const area of ["projects","agents"]) for(const status of [403,404,500]) it(`sanitizes ${area} ${status} and distinguishes failure from empty`,async()=>{
 const f=mount("/app/admin/"+area,{respond:async()=>({status,body:{error:{code:"FORBIDDEN",message:"sensitive upstream"}}})});await screen.findAllByRole("alert",{}, {timeout:10000});expect(f.container.textContent).not.toContain("sensitive upstream");await waitFor(()=>expect(screen.queryByRole("table")).toBeNull());expect(screen.queryByText("No projects were returned.")).toBeNull();expect(screen.queryByText("No visible agents were returned.")).toBeNull();f.close();
});
for(const theme of ["light","dark"]) for(const path of ["projects","projects/payments","agents","agents/rovara-code/versions"]) it(`has accessible ${path} in ${theme}`,async()=>{const f=mount("/app/admin/"+path,{theme});await screen.findByRole("table");await expectNoAxeViolations(f.container);f.close();});

for(const area of ["projects","agents"]) it(`keeps ${area} focus during refresh, labels temporary failures stale and hides denied rows`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");const table=screen.getByRole("table"),input=screen.getByRole("searchbox");input.focus();
 let resolve!:(r:ApiResponse)=>void;const delayed=new Promise<ApiResponse>(r=>{resolve=r;});f.request.mockImplementation(async()=>delayed);
 let refresh!:Promise<unknown>;await act(async()=>{refresh=f.query.invalidateQueries({queryKey:["admin",area]});});expect(screen.getByRole("table")).toBe(table);expect(document.activeElement).toBe(input);
 await act(async()=>{resolve({status:403,body:{}});await refresh;});await waitFor(()=>expect(screen.queryByRole("table")).toBeNull());f.close();
});
for(const area of ["projects","agents"]) it(`distinguishes successful empty ${area} and rejects malformed lists`,async()=>{
 const f=mount("/app/admin/"+area,{respond:async()=>({status:200,body:area==="projects"?{projects:[]}:{agents:[]}})});await screen.findByText(area==="projects"?"No projects were returned.":/No visible agents were returned/);
 f.request.mockImplementation(async()=>({status:200,body:area==="projects"?{projects:[{name:"bad"}]}:{agents:[{name:"bad"}]}}));await act(async()=>{await f.query.invalidateQueries({queryKey:["admin",area]});});await screen.findAllByRole("alert");expect(screen.queryByText("bad")).toBeNull();f.close();
});
for(const area of ["projects","agents"]) it(`labels cached ${area} stale after a temporary failure and recovers`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");f.request.mockImplementation(async()=>({status:503,body:{}}));await act(async()=>{await f.query.invalidateQueries({queryKey:["admin",area]});});expect(screen.getByRole("table")).toBeTruthy();expect((await screen.findAllByRole("alert")).some(n=>n.textContent?.includes("stale"))).toBe(true);
 f.request.mockImplementation(async()=>({status:200,body:area==="projects"?{projects:[]}:{agents:[]}}));await act(async()=>{await f.query.invalidateQueries({queryKey:["admin",area]});});await waitFor(()=>expect(screen.queryByRole("table")).toBeNull());f.close();
});
for(const area of ["projects","agents"]) it(`drops late ${area} responses from the previous company`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");const oldKey=["admin",area,f.me.org.orgId,f.me.developer.id,"list"];
 let resolve!:(r:ApiResponse)=>void;const delayed=new Promise<ApiResponse>(r=>{resolve=r;});let reads=0;
 const next=structuredClone(f.me);next.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";
 f.request.mockImplementation(async r=>r.path.endsWith("/me")?{status:200,body:next}:++reads===1?delayed:{status:200,body:area==="projects"?{projects:[]}:{agents:[]}});
 await act(async()=>{void f.query.invalidateQueries({queryKey:["admin",area]});});await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});
 await waitFor(()=>expect(f.query.getQueryData(oldKey)).toBeUndefined());await act(async()=>resolve({status:200,body:area==="projects"?{projects:[project]}:{agents:[agent]}}));await waitFor(()=>expect(screen.queryByRole("table")).toBeNull());f.close();
});
it("strips recipe metadata and private fields from the agent list cache",async()=>{
 const f=mount("/app/admin/agents",{respond:async r=>({status:200,body:r.path.includes("guardrails")?{guardrails,revision:1}:{agents:[{...agent,secretMetadata:"unneeded",email:"synthetic@example.test"}]}})});await screen.findByRole("table");const cached=JSON.stringify(f.query.getQueriesData({queryKey:["admin","agents"]}));expect(cached).not.toContain("unneeded");expect(cached).not.toContain("synthetic@example.test");f.close();
});

for(const area of ["projects","agents"]) it(`keeps the actual ${area} refresh control focusable and guards duplicate refreshes`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");const button=screen.getByRole("button",{name:"Refresh "+area});button.focus();
 let resolve!:(r:ApiResponse)=>void;const pending=new Promise<ApiResponse>(r=>{resolve=r;});let reads=0;f.request.mockImplementation(async()=>{reads++;return pending;});
 fireEvent.click(button);await waitFor(()=>expect(reads).toBe(1));expect(button.hasAttribute("disabled")).toBe(false);expect(button.getAttribute("aria-disabled")).toBe("true");expect(button.getAttribute("aria-busy")).toBe("true");fireEvent.click(button);expect(reads).toBe(1);
 await act(async()=>resolve({status:200,body:area==="projects"?{projects:[project]}:{agents:[agent]}}));await waitFor(()=>expect(button.getAttribute("aria-disabled")).not.toBe("true"));expect(screen.getByRole("button",{name:"Refresh "+area})).toBe(button);expect(document.activeElement).toBe(button);f.close();
});
for(const area of ["projects","agents"]) it(`keeps the actual ${area} retry control mounted and focused through pending and success`,async()=>{
 const f=mount("/app/admin/"+area,{respond:async()=>({status:403,body:{}})});await screen.findAllByRole("alert");const button=screen.getAllByRole("button",{name:"Try again"})[0]!;button.focus();
 let resolve!:(r:ApiResponse)=>void;const pending=new Promise<ApiResponse>(r=>{resolve=r;});let reads=0;f.request.mockImplementation(async()=>{reads++;return pending;});fireEvent.click(button);
 await waitFor(()=>expect(reads).toBe(1));await waitFor(()=>expect(button.isConnected).toBe(true));expect(button.hasAttribute("disabled")).toBe(false);expect(document.activeElement).toBe(button);
 await act(async()=>resolve({status:200,body:area==="projects"?{projects:[project]}:{agents:[agent]}}));await screen.findByRole("table");expect(screen.getByRole("button",{name:"Refresh "+area})).toBe(button);expect(document.activeElement).toBe(button);f.close();
});
for(const [status,label] of [["unchecked","Not checked yet"],["checking","Checking"],["ready","Ready"],["failed","Failed"],["outdated","Out of date"]]) it(`uses plain project setup words for ${status}`,async()=>{
 const f=mount("/app/admin/projects",{respond:async()=>({status:200,body:{projects:[{...project,setup:{status}}]}})});await screen.findByRole("table");expect(screen.getByRole("table").textContent).toContain(label);expect(screen.getByRole("table").textContent).toContain("Maintainer");f.close();
 const detail=mount("/app/admin/projects/payments",{respond:async r=>({status:200,body:r.path.endsWith("/members")?{members:[]}:{...project,setup:{status}}})});await screen.findByText("Setup status: "+label);detail.close();
});

for(const [path,title] of [["/app/admin/agents","Agents"],["/app/admin/agents/rovara-code/versions","Agent versions"]])it(`UX3 shipped console wires ${path} into company settings`,async()=>{const f=mount(path,{shipped:true});await screen.findByRole("heading",{name:title,level:1});expect(screen.getByRole("link",{name:"Agents"}).getAttribute("href")).toBe("/app/admin/agents");f.close();});

it("B32 member project maintainer has own-project settings entry and no admin navigation",async()=>{const value=projectFixture();value.project.setup.status="failed";const f=mount("/app/projects/payments",{role:"member",shipped:true,respond:async r=>r.path.endsWith("/overview")?{status:200,body:value}:{status:200,body:{notices:[],next:"settled"}}});await screen.findByRole("heading",{name:"payments"});expect(screen.getByRole("link",{name:"Setup needs attention"}).getAttribute("href")).toBe("/app/onboard?project=payments&step=setup");expect(screen.queryByRole("link",{name:/^Admin$/})).toBeNull();expect(screen.queryByRole("navigation",{name:"Administration"})).toBeNull();expect(f.request.mock.calls.filter(([r])=>r.path.includes("/projects/")).every(([r])=>r.path.includes("/projects/payments/"))).toBe(true);f.close();});
it("opens website editing from fresh active admin project detail without changing navigation", async () => {
 const f = mount("/app/admin/projects/payments", { shipped: true, respond: async request => ({ status: 200, body: request.path.includes("allowed-websites") ? { kind: "review", status: "review", orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", baseRevision: 3, contextDigest: "b".repeat(64), allowedDomains: ["docs.acme.dev"], defaultDomains: ["github.com"], staffDomains: [{ domain: "docs.acme.dev", status: "pending" }], liveProposal: null } : request.path.endsWith("/members") ? { members: [] } : project }) });
 await screen.findByRole("heading", { name: "Allowed websites" });
 expect(f.request.mock.calls.some(([r]) => r.path.includes("allowed-websites"))).toBe(false);
 fireEvent.click(screen.getByRole("button", { name: "Edit allowed websites" }));await screen.findByRole("button", { name: "Review website change" });
 expect(screen.getByText("github.com")).toBeTruthy();expect(screen.queryByRole("link", { name: "Agents" })).toBeNull();
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);f.close();
});
it("B33 member maintainer opens company-pinned website editing on the shipped own-project route", async () => {
 let revoked = false;
 const value = projectFixture({ orgId: "org_aaaaaaaaaaaaaaaaaaaa" });
 const f = mount("/app/projects/payments", { role: "member", shipped: true, respond: async r => r.path.endsWith("/overview") ? { status: 200, body: value } : r.path.includes("/allowed-websites") ? revoked ? { status: 403, body: { error: { code: "FORBIDDEN" } } } : { status: 200, body: { kind: "review", status: "review", orgId: value.orgId, project: "payments", baseRevision: 1, contextDigest: "b".repeat(64), allowedDomains: [], defaultDomains: ["github.com"], staffDomains: [], liveProposal: null } } : { status: 200, body: { notices: [], next: "settled" } } });
 await screen.findByRole("button", { name: "Edit allowed websites" });fireEvent.click(screen.getByRole("button", { name: "Edit allowed websites" }));await screen.findByRole("button", { name: "Review website change" });
 expect(screen.queryByRole("link", { name: /^Admin$/ })).toBeNull();expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
 revoked = true;await act(async () => { window.dispatchEvent(new Event("focus")); });await screen.findByText(/Website settings could not be checked/);
 expect(screen.queryByRole("button", { name: "Review website change" })).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST" && !r.path.endsWith("/start-preview"))).toHaveLength(0);f.close();
});
for (const state of ["viewer", "archived"] as const) it(`B33 own-project ${state} has no website mutation entry`, async () => {
 const value = projectFixture({ orgId: "org_aaaaaaaaaaaaaaaaaaaa" });
 if (state === "viewer") value.you = { role: "viewer", canStartWork: false, canEditSettings: false, canViewSpend: false };else { value.project.status = "archived";value.you.canEditSettings = false; }
 const f = mount("/app/projects/payments", { role: "member", shipped: true, respond: async r => ({ status: 200, body: r.path.endsWith("/overview") ? value : { notices: [], next: "settled" } }) });
 await screen.findByRole("heading", { name: "payments" });expect(screen.queryByRole("button", { name: "Edit allowed websites" })).toBeNull();expect(f.request.mock.calls.some(([r]) => r.path.includes("allowed-websites"))).toBe(false);f.close();
});
for (const status of ["active", "archived"] as const) it(`B34 opens recorded Slack links from fresh ${status} admin detail without navigation changes`, async () => {
 const inventory = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", workspaces: [], bindings: [], continuation: null, partial: false, limitReached: false, inspected: 0, botMembership: "not_verified" };
 const f = mount("/app/admin/projects/payments", { shipped: true, respond: async r => ({ status: 200, body: r.path.includes("/slack-channel/") ? inventory : r.path.endsWith("/members") ? { members: [] } : { ...project, status } }) });
 await screen.findByRole("heading", { name: "Slack channels" });expect(f.request.mock.calls.some(([r]) => r.path.includes("/slack-channel/"))).toBe(false);
 fireEvent.click(screen.getByRole("button", { name: "Manage recorded Slack links" }));await screen.findByRole("region", { name: "Slack links editor" });expect(screen.queryByRole("button", { name: /Bind|Link replacement/ })).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);f.close();
});
it("B35 Health overview links to read-only web and API service status details", async () => {
 const orgId = meFixture().org.orgId, checkedAt = "2026-10-30T14:30:00.000Z";
 const f = mount("/app/admin", { shipped: true, respond: async () => ({ status: 200, body: { orgId, checkedAt, configured: true, source: "stored_runtime_qualification", checks: [{ kind: "web", state: "ready", observation: "qualified", reason: "qualified", expiresAt: "2026-11-02T14:30:00.000Z" }, { kind: "api", state: "unknown", observation: "unknown", reason: "not_observed" }] } }) });
 fireEvent.click(await screen.findByRole("link", { name: "Review Rovara service status" }));await screen.findByRole("heading", { name: "Rovara service status" });
 fireEvent.click(await screen.findByRole("link", { name: "browser runtime" }));await screen.findByRole("table", { name: "Stored browser runtime qualification" });
 expect(f.request.mock.calls.filter(([input]) => input.path.includes("service-status")).every(([input]) => input.method === "GET")).toBe(true);f.close();
});
