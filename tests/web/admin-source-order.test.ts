// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/cloud-contracts/web";
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
 let snapshot = { orgId, developerId, revision: old ? undefined : 1, sources: [] as Record<string,unknown>[], order: ["personal-chatgpt", "rovara"] }, write: ApiResponse | undefined;
 const nav = AppNavSchema.parse({ me: { developerId, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { localAgents:false, admin:true, usage:false, chains:false, describe:false, notices:false } });
 const f = fakeHost(async r => {
  if(r.path==="/v1/app/me") return {status:200,body:me};if(r.path==="/v1/app/nav") return {status:200,body:nav};
  if(r.path==="/v1/app/org/model-sources") return {status:200,body:snapshot};
  if(r.path==="/v1/app/org/model-sources-order") { if(write) return write;const b=r.body as {order:string[]};snapshot={...snapshot,order:b.order,revision:(snapshot.revision??0)+1};return {status:200,body:{order:snapshot.order,revision:snapshot.revision}}; }
  return {status:200,body:{cards:[],total:0}};
 });f.host.kind="web";f.host.viewport={width:()=>1280,subscribe:()=>()=>undefined};const query=createQueryClient();query.setQueryData(["nav"],nav);const router=createMemoryRouter(appRoutes(nav.features),{initialEntries:["/app/admin/models/sources"]});const view=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(ThemeProvider,{host:f.host,children:h(RouterProvider,{router})})})}));
 return {...f,query,router,me, setSnapshot(value:Partial<typeof snapshot>){snapshot={...snapshot,...value};},setWrite(value:ApiResponse){write=value;},writes:()=>f.request.mock.calls.filter(([r])=>r.method!=="GET"),close(){view.unmount();router.dispose();query.clear();}};
}
async function propose(){fireEvent.click(await screen.findByRole("button",{name:"Change source order"}));await screen.findByRole("button",{name:"Move up, Rovara"});fireEvent.click(screen.getByRole("button",{name:"Move up, Rovara"}));}
async function review(){await propose();fireEvent.click(screen.getByRole("button",{name:"Review order"}));await screen.findByRole("button",{name:"Confirm source order"});}
for(const role of ["owner","admin"] as const) it(`reviews and canonically verifies one company/person-bound reorder for ${role}`,async()=>{
 const f=mount(role);await screen.findByRole("heading",{name:"AI models"});expect(f.writes()).toHaveLength(0);await review();expect(f.writes()).toHaveLength(0);expect(screen.getByText(/Costs can change/)).toBeTruthy();const confirm=screen.getByRole("button",{name:"Confirm source order"});fireEvent.click(confirm);fireEvent.click(confirm);await screen.findByText("Source order verified.");expect(f.writes()).toHaveLength(1);const request=f.writes()[0]![0];expect(request.path).toBe("/v1/app/org/model-sources-order");expect(request.body).toMatchObject({expectedOrgId:orgId,expectedDeveloperId:developerId,expectedRevision:1,order:["rovara","personal-chatgpt"]});expect((request.body as {requestId:string}).requestId).toMatch(/^[a-f0-9-]{36}$/);expect(f.request.mock.calls.filter(([r])=>r.path.endsWith("/model-sources")).length).toBeGreaterThanOrEqual(4);f.close();
});
it("refuses a canonical revision change before review without a write",async()=>{
 const f=mount();await propose();f.setSnapshot({revision:2});fireEvent.click(screen.getByRole("button",{name:"Review order"}));await waitFor(()=>expect(screen.queryByText("Sources changed. Review the current order again.")).toBeTruthy());expect(screen.queryByRole("button",{name:"Confirm source order"})).toBeNull();expect(f.writes()).toHaveLength(0);f.close();
});
it("rechecks live role before confirming and discards a revoked proposal",async()=>{
 const f=mount();await review();f.me.developer.orgRole="member";fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await screen.findByRole("heading",{name:"Administration unavailable"});expect(f.writes()).toHaveLength(0);f.close();
});
it("locks an ambiguous outcome and only reads when checking it",async()=>{
 const f=mount();await review();f.setWrite({status:503,body:{error:{code:"AUDIT_UNAVAILABLE",message:"untrusted detail"}}});fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await screen.findByText("The outcome is unknown. Check the current order before making another change.");expect(f.writes()).toHaveLength(1);f.setSnapshot({revision:2,order:["rovara","personal-chatgpt"]});fireEvent.click(screen.getByRole("button",{name:"Check current order"}));await screen.findByText("Current source order checked. The request outcome remains unconfirmed.");expect(f.writes()).toHaveLength(1);expect(screen.queryByRole("button",{name:"Confirm source order"})).toBeNull();expect(screen.queryByText("Source order verified.")).toBeNull();expect(screen.queryByText("untrusted detail")).toBeNull();f.close();
});
it("keeps editing unavailable without a canonical revision",async()=>{
 const f=mount("owner",true);const edit=await screen.findByRole("button",{name:"Change source order"});expect(edit).toHaveProperty("disabled",true);fireEvent.click(edit);expect(screen.queryByRole("dialog")).toBeNull();expect(f.writes()).toHaveLength(0);f.close();
});
it("discards a proposal when active company changes",async()=>{
 const f=mount();await review();f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(f.writes()).toHaveLength(0);expect(f.query.getQueriesData({queryKey:["admin","lane-c","sources",orgId]})).toEqual([]);f.close();
});
it("rechecks the canonical revision again immediately before submitting",async()=>{
 const f=mount();await review();f.setSnapshot({revision:2});fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await waitFor(()=>expect(screen.queryByText("Sources changed. Review the current order again.")).toBeTruthy());expect(f.writes()).toHaveLength(0);f.close();
});
it("does not claim success from a receipt without matching canonical state",async()=>{
 const f=mount();await review();f.setWrite({status:200,body:{order:["rovara","personal-chatgpt"],revision:2}});fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await waitFor(()=>expect(screen.queryByText("Current source state differs from the response. Close and reload before another change.")).toBeTruthy());expect(screen.queryByText("Source order verified.")).toBeNull();expect(f.writes()).toHaveLength(1);f.close();
});
for(const changedContext of ["company","person"] as const) it(`refuses a fresh snapshot for a different ${changedContext} before review`,async()=>{
 const f=mount();await propose();f.setSnapshot(changedContext==="company"?{orgId:"org_bbbbbbbbbbbbbbbbbbbb"}:{developerId:"b".repeat(64)});fireEvent.click(screen.getByRole("button",{name:"Review order"}));await waitFor(()=>expect(screen.queryByText("Couldn't verify the current source order. Try again.")).toBeTruthy());expect(screen.queryByRole("button",{name:"Confirm source order"})).toBeNull();expect(f.writes()).toHaveLength(0);f.close();
});
it("discards the old person's proposal when confirmation detects a new sign-in",async()=>{
 const f=mount();await review();f.me.developer.id="b".repeat(64);fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(f.writes()).toHaveLength(0);expect(f.query.getQueriesData({queryKey:["admin","lane-c","sources",orgId,developerId]})).toEqual([]);f.close();
});
it("projects canonical source data before publishing verified cache state",async()=>{
 const f=mount(),id="src_"+"c".repeat(20);f.setSnapshot({sources:[{sourceId:id,kind:"openai",label:"Configured source",hasCredential:true,inOrder:true,models:[{catalog:{provider:"openai",modelId:"sample"}}],unneededPrivateField:"unneeded-private-field"}],order:[id,"rovara"]});await propose();fireEvent.click(screen.getByRole("button",{name:"Review order"}));await screen.findByRole("button",{name:"Confirm source order"});fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));await screen.findByText("Source order verified.");expect(JSON.stringify(f.query.getQueriesData({queryKey:["admin","lane-c","sources"]}))).not.toContain("unneeded-private-field");expect(screen.queryByText("unneeded-private-field")).toBeNull();f.close();
});
it("offers no source-order editor or write to an ordinary member",async()=>{
 const f=mount("member");await screen.findByRole("heading",{name:"Administration unavailable"});expect(screen.queryByRole("button",{name:"Change source order"})).toBeNull();expect(f.writes()).toHaveLength(0);expect(f.request.mock.calls.some(([r])=>r.path.endsWith("/model-sources"))).toBe(false);f.close();
});
it("keeps a pending intent locked with visible outcome checking and no second write",async()=>{
 const f=mount();await review();const original=f.request.getMockImplementation()!;let resolve!:(value:ApiResponse)=>void;const pending=new Promise<ApiResponse>(done=>{resolve=done;});f.request.mockImplementation(async r=>r.path.endsWith("/model-sources-order")?pending:original(r));const confirm=screen.getByRole("button",{name:"Confirm source order"});fireEvent.click(confirm);
 try{await screen.findByText("Checking the source-order outcome...");expect(screen.getByRole("button",{name:"Check current order"})).toHaveProperty("disabled",true);fireEvent.click(confirm);fireEvent.keyDown(screen.getByRole("dialog"),{key:"Escape"});expect(screen.getByRole("dialog")).toBeTruthy();expect(f.writes()).toHaveLength(1);}finally{f.setSnapshot({revision:2,order:["rovara","personal-chatgpt"]});await act(async()=>{resolve({status:200,body:{order:["rovara","personal-chatgpt"],revision:2}});});await screen.findByText("Source order verified.");f.close();}
});
it("discards an unsent intent and cached result when navigation unmounts its pending preflight",async()=>{
 const f=mount();await review();const original=f.request.getMockImplementation()!;let resolve!:(value:ApiResponse)=>void,started=false;const pending=new Promise<ApiResponse>(done=>{resolve=done;});f.request.mockImplementation(async r=>{if(r.path.endsWith("/model-sources")){started=true;return pending;}return original(r);});fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));
 try{await waitFor(()=>expect(started).toBe(true));await act(async()=>{await f.router.navigate("/app/admin/people");});await act(async()=>{resolve({status:200,body:{orgId,developerId,revision:1,sources:[],order:["personal-chatgpt","rovara"]}});await new Promise(done=>setTimeout(done,30));});expect(f.writes()).toHaveLength(0);expect(f.query.getQueriesData({queryKey:["admin","lane-c","sources",orgId,developerId]})).toEqual([]);}finally{resolve({status:200,body:{orgId,developerId,revision:1,sources:[],order:["personal-chatgpt","rovara"]}});f.close();}
});
it("does not recreate old-person source cache if identity changes while canonical publication is awaiting cancellation",async()=>{
 const f=mount();await review();const cancel=f.query.cancelQueries.bind(f.query);let resume!:()=>void,paused=false,first=true;const waiting=new Promise<void>(resolve=>{resume=resolve;});f.query.cancelQueries=async(...args:Parameters<typeof f.query.cancelQueries>)=>{const complete=cancel(...args);if(first&&args[0]?.queryKey?.[2]==="sources"){first=false;paused=true;await waiting;}await complete;};
 fireEvent.click(screen.getByRole("button",{name:"Confirm source order"}));try{await waitFor(()=>expect(paused).toBe(true));f.me.developer.id="b".repeat(64);await act(async()=>{await f.query.invalidateQueries({queryKey:["admin","identity"]});});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());await act(async()=>{resume();await new Promise(resolve=>setTimeout(resolve,30));});expect(f.writes()).toHaveLength(1);expect(f.query.getQueriesData({queryKey:["admin","lane-c","sources",orgId,developerId]})).toEqual([]);}finally{resume();f.query.cancelQueries=cancel;f.close();}
});
it("refreshes authority and evicts the old company when a canonical read reveals a live company switch",async()=>{
 const f=mount();await propose();const original=f.request.getMockImplementation()!;let switched=false;f.request.mockImplementation(async r=>{if(r.path.endsWith("/model-sources")){switched=true;f.me.org.orgId="org_bbbbbbbbbbbbbbbbbbbb";f.setSnapshot({orgId:f.me.org.orgId});}return original(r);});fireEvent.click(screen.getByRole("button",{name:"Review order"}));await waitFor(()=>expect(switched).toBe(true));try{await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(f.writes()).toHaveLength(0);expect(f.query.getQueriesData({queryKey:["admin","lane-c","sources",orgId,developerId]})).toEqual([]);}finally{f.close();}
});
it("keeps the visible move label at the start of its accessible name",async()=>{
 const f=mount();fireEvent.click(await screen.findByRole("button",{name:"Change source order"}));await screen.findByRole("heading",{name:"Proposed order"});try{const up=screen.queryByRole("button",{name:"Move up, Rovara"}),down=screen.queryByRole("button",{name:"Move down, Personal ChatGPT"});expect(up).not.toBeNull();expect(down).not.toBeNull();expect(up?.textContent).toBe("Move up");expect(down?.textContent).toBe("Move down");}finally{f.close();}
});
it("announces the moved source position and retains keyboard focus on its enabled counterpart",async()=>{
 const f=mount();await propose();try{const position=screen.queryByText("Rovara moved to position 1 of 2.");expect(position).not.toBeNull();expect(position?.getAttribute("aria-live")).toBe("polite");expect(position?.getAttribute("aria-atomic")).toBe("true");const down=screen.getByRole("button",{name:"Move down, Rovara"});expect(document.activeElement).toBe(down);expect(down).toHaveProperty("disabled",false);fireEvent.click(down);expect(screen.getByText("Rovara moved to position 2 of 2.")).toBeTruthy();const up=screen.getByRole("button",{name:"Move up, Rovara"});expect(document.activeElement).toBe(up);expect(up).toHaveProperty("disabled",false);}finally{f.close();}
});
it("connects unavailable snapshot guidance to the disabled editor trigger",async()=>{
 const f=mount("owner",true);const trigger=await screen.findByRole("button",{name:"Change source order"});try{expect(trigger).toHaveProperty("disabled",true);const description=trigger.getAttribute("aria-describedby");expect(description).toBeTruthy();expect(document.getElementById(description??"")?.textContent).toContain("Source-order editing is unavailable until a current company, sign-in and revision snapshot");}finally{f.close();}
});
it("announces escaped control and format characters from a source label",async()=>{
 const f=mount(),id="src_"+"c".repeat(20);f.setSnapshot({sources:[{sourceId:id,kind:"openai",label:"Source\u0007\u202E",hasCredential:false,inOrder:true,models:[]}],order:[id,"rovara"]});fireEvent.click(await screen.findByRole("button",{name:"Change source order"}));const down=await screen.findByRole("button",{name:"Move down, Source[U+0007][U+202E]"});fireEvent.click(down);try{const status=screen.queryByText("Source[U+0007][U+202E] moved to position 2 of 2.");expect(status).not.toBeNull();expect(status?.textContent).not.toContain("\u0007");expect(status?.textContent).not.toContain("\u202E");expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
for(const role of ["owner","admin"] as const)it(`retains the moved ${role} source's direction in a four-source middle and uses the counterpart only at boundaries`,async()=>{
 const f=mount(role),first="src_"+"c".repeat(20),second="src_"+"d".repeat(20);f.setSnapshot({sources:[{sourceId:first,kind:"openai",label:"First source",hasCredential:false,inOrder:true,models:[]},{sourceId:second,kind:"openai",label:"Second source",hasCredential:false,inOrder:true,models:[]}],order:["personal-chatgpt",first,second,"rovara"]});fireEvent.click(await screen.findByRole("button",{name:"Change source order"}));const down=await screen.findByRole("button",{name:"Move down, First source"});try{fireEvent.click(down);expect(screen.getByText("First source moved to position 3 of 4.")).toBeTruthy();expect(document.activeElement).toBe(down);expect(down).toHaveProperty("disabled",false);fireEvent.click(down);const up=screen.getByRole("button",{name:"Move up, First source"});expect(screen.getByText("First source moved to position 4 of 4.")).toBeTruthy();expect(document.activeElement).toBe(up);expect(up).toHaveProperty("disabled",false);fireEvent.click(up);expect(screen.getByText("First source moved to position 3 of 4.")).toBeTruthy();expect(document.activeElement).toBe(up);fireEvent.click(up);expect(screen.getByText("First source moved to position 2 of 4.")).toBeTruthy();expect(document.activeElement).toBe(up);fireEvent.click(up);expect(screen.getByText("First source moved to position 1 of 4.")).toBeTruthy();expect(document.activeElement).toBe(down);expect(down).toHaveProperty("disabled",false);expect(f.writes()).toHaveLength(0);}finally{f.close();}
});
