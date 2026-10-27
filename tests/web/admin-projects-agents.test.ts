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
import { expectNoAxeViolations } from "./support/axe.js";
const project = { name: "payments", description: "Payment service", status: "active", latestRevision: 3, repositories: [{ fullName: "Acme/payments", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "ready" }, settings: { setupCommands: ["sensitive command"], testCommands: ["sensitive test"], devcontainer: null, allowedDomains: [{ domain: "docs.example.com", status: "pending" }] }, createdAt: "2026-10-01T00:00:00Z", createdBy: { developerId: "a".repeat(64), name: "Priya" } };
const agent = { agentId: "rovara-code", name: "Rovara Code", description: "Build code", builtin: true, status: "active", access: "edit", latestVersion: 2, pinnedVersion: 1, monthlyBudgetUsd: 0 };
const guardrails = { maxAutonomy: "prepare", forbiddenModels: [], requireCrossCompanyReview: true, maxAgentMonthlyUsd: 100, maxPerRunCeilingUsd: 10, disabledBuiltins: [], extraTriggerLabels: [], extraCommandWords: [], reportLinkDomains: [] };
function mount(path = "/app/admin/projects", options: {role?:string; respond?:(r:ApiRequest)=>Promise<ApiResponse>; theme?:string} = {}) {
 const me = meFixture();me.developer.orgRole = (options.role ?? "owner") as typeof me.developer.orgRole;
 const nav = navFixture({ me: { developerId: me.developer.id, name: "Priya", orgRole: "owner" }, features: { localAgents:false, admin:true, usage:false, chains:false, describe:false, notices:false } });
 const f = fakeHost(async r => {
  if (r.path === "/v1/app/me") return { status:200, body:me };
  if (r.path === "/v1/app/nav") return { status:200, body:nav };
  if (options.respond) return options.respond(r);
  return { status:200, body:r.path.includes("/versions") ? { versions:[{version:1,current:true},{version:2,safety:"unknown"}] } : r.path.includes("agent-guardrails") ? {guardrails,revision:1} : r.path.includes("/agents?") ? {agents:[agent]} : r.path.endsWith("/members") ? {members:[{developerId:"b".repeat(64),name:"Maya",role:"contributor",source:"grant",email:"synthetic@example.test"}]} : r.path === "/v1/app/projects/payments" ? project : {projects:[project,{...project,name:"old",status:"archived"}]} };
 });
 const query = createQueryClient();query.setQueryData(["nav"],nav);f.storage.set("rovara.theme",options.theme??"light");
 const router = createMemoryRouter(appRoutes(nav.features),{initialEntries:[path]});
 const view = renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));
 return {...f,...view,me,query,router,close(){view.unmount();router.dispose();query.clear();}};
}
for(const role of ["owner","admin"]) it(`shows read-only projects for ${role} and preserves list filters through detail`,async()=>{
 const f=mount("/app/admin/projects",{role});await screen.findByRole("link",{name:"payments"});expect(screen.queryByRole("link",{name:"old"})).toBeNull();
 fireEvent.change(screen.getByRole("searchbox",{name:"Find in this project list"}),{target:{value:"payment"}});fireEvent.click(screen.getByRole("link",{name:"payments"}));
 await screen.findByRole("heading",{name:"payments"});await screen.findByText("Maya");expect(screen.getByText("Using GitHub default branch")).toBeTruthy();expect(screen.getByText("Project grant")).toBeTruthy();
 expect(f.container.textContent).not.toContain("sensitive command");expect(JSON.stringify(f.query.getQueriesData({queryKey:["admin","project-members"]}))).not.toContain("synthetic@example.test");
 fireEvent.click(screen.getByRole("link",{name:"Back to projects"}));await screen.findByRole("searchbox");expect(screen.getByRole("searchbox")).toHaveProperty("value","payment");expect(f.request.mock.calls.every(([r])=>r.method==="GET")).toBe(true);f.close();
});
for(const role of ["member","maintainer","viewer","future-role"]) for(const path of ["projects","agents"]) it(`refuses ${role} at ${path} without area reads`,async()=>{
 const f=mount("/app/admin/"+path,{role});await screen.findByRole("heading",{name:"Administration unavailable"});expect(f.request.mock.calls.some(([r])=>r.path.includes("/projects")||r.path.includes("/agents"))).toBe(false);f.close();
});
it("shows visible agent pins, versions and guardrails without write controls",async()=>{
 const f=mount("/app/admin/agents");await screen.findByRole("table",{name:"Visible agents"});expect(screen.getByText("Visible agents only; this is not a complete company adoption inventory.")).toBeTruthy();expect(screen.getByText("Maximum autonomy: prepare")).toBeTruthy();
 expect(screen.queryByRole("button",{name:/Adopt|Save|Publish/})).toBeNull();fireEvent.click(screen.getByRole("link",{name:"Versions for Rovara Code"}));await screen.findByRole("table",{name:"Agent versions"});expect(screen.getByText("Unknown")).toBeTruthy();expect(f.request.mock.calls.every(([r])=>r.method==="GET")).toBe(true);f.close();
});
for(const area of ["projects","agents"]) it(`clears ${area} after access revocation`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");f.me.developer.orgRole="member";await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await screen.findByRole("heading",{name:"Administration unavailable"});expect(screen.queryByRole("table")).toBeNull();await waitFor(()=>expect(f.query.getQueriesData({queryKey:["admin",area]})).toEqual([]));f.close();
});
for(const field of ["org","developer"]) for(const area of ["projects","agents"]) it(`isolates ${area} on ${field} change`,async()=>{
 const f=mount("/app/admin/"+area);await screen.findByRole("table");const oldOrg=f.me.org.orgId,oldPerson=f.me.developer.id;
 if(field==="org")f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";else f.me.developer.id="c".repeat(64);
 let resolve!:(r:ApiResponse)=>void;const delayed=new Promise<ApiResponse>(r=>{resolve=r;});f.request.mockImplementation(async r=>r.path.endsWith("/me")?{status:200,body:f.me}:delayed);
 await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});expect(screen.queryByRole("table")).toBeNull();await waitFor(()=>expect(f.query.getQueryData(["admin",area,oldOrg,oldPerson])).toBeUndefined());
 await act(async()=>resolve({status:200,body:area==="projects"?{projects:[]}:{agents:[]}}));f.close();
});
for(const area of ["projects","agents"]) for(const status of [403,404,500]) it(`sanitizes ${area} ${status} and distinguishes failure from empty`,async()=>{
 const f=mount("/app/admin/"+area,{respond:async()=>({status,body:{error:{code:"FORBIDDEN",message:"sensitive upstream"}}})});await screen.findAllByRole("alert");expect(f.container.textContent).not.toContain("sensitive upstream");expect(screen.queryByRole("table")).toBeNull();expect(screen.queryByText("No projects were returned.")).toBeNull();expect(screen.queryByText("No visible agents were returned.")).toBeNull();f.close();
});
for(const theme of ["light","dark"]) for(const path of ["projects","projects/payments","agents","agents/rovara-code/versions"]) it(`has accessible ${path} in ${theme}`,async()=>{const f=mount("/app/admin/"+path,{theme});await screen.findByRole("table");await expectNoAxeViolations(f.container);f.close();});
