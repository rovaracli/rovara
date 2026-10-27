// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", developerId = "a".repeat(64);
function mount(role: "owner"|"admin"|"member" = "owner", old = false) {
 const me = { developer: { id: developerId, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 let snapshot = { orgId, developerId, revision: old ? undefined : 1, sources: [], order: ["personal-chatgpt", "rovara"] }, write: ApiResponse | undefined;
 const nav = AppNavSchema.parse({ me: { developerId, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents:false, admin:true, usage:false, chains:false, describe:false, notices:false } });
 const f = fakeHost(async r => {
  if(r.path==="/v1/app/me") return {status:200,body:me};if(r.path==="/v1/app/nav") return {status:200,body:nav};
  if(r.path==="/v1/app/org/model-sources") return {status:200,body:snapshot};
  if(r.path==="/v1/app/org/model-sources-order") { if(write) return write;const b=r.body as {order:string[]};snapshot={...snapshot,order:b.order,revision:(snapshot.revision??0)+1};return {status:200,body:{order:snapshot.order,revision:snapshot.revision}}; }
  return {status:200,body:{cards:[],total:0}};
 });f.host.kind="web";f.host.viewport={width:()=>1280,subscribe:()=>()=>undefined};const query=createQueryClient();query.setQueryData(["nav"],nav);const router=createMemoryRouter(appRoutes(nav.features),{initialEntries:["/app/admin/models/sources"]});const view=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));
 return {...f,query,me, setSnapshot(value:Partial<typeof snapshot>){snapshot={...snapshot,...value};},setWrite(value:ApiResponse){write=value;},writes:()=>f.request.mock.calls.filter(([r])=>r.method!=="GET"),close(){view.unmount();router.dispose();query.clear();}};
}
async function propose(){fireEvent.click(await screen.findByRole("button",{name:"Change source order"}));await screen.findByRole("button",{name:"Move Rovara up"});fireEvent.click(screen.getByRole("button",{name:"Move Rovara up"}));}
async function review(){await propose();fireEvent.click(screen.getByRole("button",{name:"Review order"}));await screen.findByRole("button",{name:"Confirm source order"});}
for(const role of ["owner","admin"] as const) it(`reviews and canonically verifies one company/person-bound reorder for ${role}`,async()=>{
 const f=mount(role);await screen.findByRole("heading",{name:"AI models"});expect(f.writes()).toHaveLength(0);await review();expect(f.writes()).toHaveLength(0);expect(screen.getByText(/Costs can change/)).toBeTruthy();const confirm=screen.getByRole("button",{name:"Confirm source order"});fireEvent.click(confirm);fireEvent.click(confirm);await screen.findByText("Source order verified.");expect(f.writes()).toHaveLength(1);const request=f.writes()[0]![0];expect(request.path).toBe("/v1/app/org/model-sources-order");expect(request.body).toMatchObject({expectedOrgId:orgId,expectedDeveloperId:developerId,expectedRevision:1,order:["rovara","personal-chatgpt"]});expect((request.body as {requestId:string}).requestId).toMatch(/^[a-f0-9-]{36}$/);expect(f.request.mock.calls.filter(([r])=>r.path.endsWith("/model-sources")).length).toBeGreaterThanOrEqual(4);f.close();
});
it("refuses a canonical revision change before review without a write",async()=>{
 const f=mount();await propose();f.setSnapshot({revision:2});fireEvent.click(screen.getByRole("button",{name:"Review order"}));await screen.findByText("Sources changed. Review the current order again.");expect(screen.queryByRole("button",{name:"Confirm source order"})).toBeNull();expect(f.writes()).toHaveLength(0);f.close();
});
it("rechecks live role before confirming and discards a revoked proposal",async()=>{
 const f=mount();await review();f.me.developer.orgRole="member";fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await screen.findByRole("heading",{name:"Administration unavailable"});expect(f.writes()).toHaveLength(0);f.close();
});
it("locks an ambiguous outcome and only reads when checking it",async()=>{
 const f=mount();await review();f.setWrite({status:503,body:{error:{code:"AUDIT_UNAVAILABLE",message:"untrusted detail"}}});fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await screen.findByText("The outcome is unknown. Check the current order before making another change.");expect(f.writes()).toHaveLength(1);fireEvent.click(screen.getByRole("button",{name:"Check current order"}));await screen.findByText("Current source order checked. The request outcome remains unconfirmed.");expect(f.writes()).toHaveLength(1);expect(screen.queryByRole("button",{name:"Confirm source order"})).toBeNull();expect(screen.queryByText("Source order verified.")).toBeNull();expect(screen.queryByText("untrusted detail")).toBeNull();f.close();
});
it("keeps editing unavailable without a canonical revision",async()=>{
 const f=mount("owner",true);const edit=await screen.findByRole("button",{name:"Change source order"});expect(edit).toHaveProperty("disabled",true);fireEvent.click(edit);expect(screen.queryByRole("dialog")).toBeNull();expect(f.writes()).toHaveLength(0);f.close();
});
it("discards a proposal when active company changes",async()=>{
 const f=mount();await review();f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(f.writes()).toHaveLength(0);expect(f.query.getQueriesData({queryKey:["admin","lane-c","sources",orgId]})).toEqual([]);f.close();
});
