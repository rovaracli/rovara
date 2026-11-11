// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SessionViewReaderSchema } from "@agentx/cloud-contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { Workspace } from "../../packages/ui/src/screens/session/Workspace.js";
import { chainRunViewOf } from "./support/chain-fixture.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
const at="2026-10-23T12:00:00.000Z",id="crn_"+"a".repeat(20);
function setup(options:{status?:"PENDING"|"APPROVED";url?:string;denied?:boolean;hash?:string;wrongTask?:boolean}={}){
 const chain=chainRunViewOf(id,{project:"payments",sections:[{seq:1,stepId:"check",name:"Investigate refunds",kind:"agent",status:"running",attempt:1,startedAt:at,agent:{agentId:"rovara-code",name:"Rovara Code",version:3},costUsd:0.25,report:"<img src=x onerror=alert(1)>",detail:{kind:"task",taskId:"11111111-1111-4111-8111-111111111111",rovaraCode:true}},{seq:2,stepId:"approve",name:"Review the evidence",kind:"gate",status:"waiting",attempt:1,startedAt:at,gate:{prompt:"Proceed with the fix?",approvers:"Payments leads",status:options.status??"PENDING",...(options.url===undefined?{}:{confirmUrl:options.url})}}]});
 const session=SessionViewReaderSchema.parse(workspaceFixture({sessionId:id,kind:"chain",body:{kind:"chain",chain}})),task=workspaceFixture().body;
 const f=fakeHost(async()=>options.denied?{status:404,body:{error:{code:"NOT_FOUND",message:"Not found."}}}:{status:200,body:{task:task.kind==="task"?{...task.task,...(options.wrongTask?{taskId:"22222222-2222-4222-8222-222222222222"}:{})}:undefined}});
 const query=createQueryClient(),router=createMemoryRouter([{path:"*",element:h("main",{},h("h1",{},"Refund investigation"),h(Workspace,{session}))}],{initialEntries:["/app/sessions/"+id+(options.hash??"")]});
 const ui=renderUi(h(AppHostProvider,{host:f.host,children:h(QueryClientProvider,{client:query,children:h(RouterProvider,{router})})}));
 return {...f,...ui,close(){ui.unmount();router.dispose();query.clear();}};
}
it("shows real sections and gate approvers, with a bare confirmation action only while pending",async()=>{
 const f=setup({url:"https://cell.example/v1/app/approve/apr_gate"});
 expect(screen.getByText("Investigate refunds")).toBeTruthy();fireEvent.click(screen.getByText("Review the evidence"));expect(screen.getByText("Payments leads")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Open"}));expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/apr_gate");
 expect(f.container.querySelector("img")).toBeNull();expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();await expectNoAxeViolations(f.container);f.close();
});
it("does not offer completed, absent, ticketed or foreign gate URLs",()=>{
 for(const option of [{status:"APPROVED" as const,url:"https://cell.example/v1/app/approve/apr_gate"},{},{url:"https://cell.example/v1/app/approve/apr_gate?ticket=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{url:"https://other.example/v1/app/approve/apr_gate"}]){const f=setup(option);fireEvent.click(screen.getByText("Review the evidence"));expect(screen.queryByRole("button",{name:"Open"})).toBeNull();f.close();}
});
it("reads a section's task only when expanded and exposes its actual evidence",async()=>{
 const f=setup();expect(f.request).not.toHaveBeenCalled();fireEvent.click(screen.getByText("Investigate refunds"));
 await waitFor(()=>expect(f.request).toHaveBeenCalledWith(expect.objectContaining({method:"GET",path:"/v1/app/sessions/"+id+"/sections/1/task"})));
 const plan=await screen.findByRole("tab",{name:"Plan"});fireEvent.mouseDown(plan,{button:0,ctrlKey:false});expect(await screen.findByRole("heading",{name:"Refund investigation",level:2})).toBeTruthy();expect(screen.queryByRole("button",{name:"Review and approve the plan"})).toBeNull();f.close();
});
it("explains the project permission on a step-task 404 without showing its evidence",async()=>{
 const f=setup({denied:true});fireEvent.click(screen.getByText("Investigate refunds"));
 expect(await screen.findByText("You need a role on payments that can start work to see this step's details.")).toBeTruthy();expect(screen.queryByRole("tab",{name:"Plan"})).toBeNull();f.close();
});

it("restores the expanded chain section and evidence tab from its URL",async()=>{
 const f=setup({hash:"#step-1-plan"});expect(await screen.findByRole("heading",{name:"Refund investigation",level:2})).toBeTruthy();f.close();
});
it("does not show a response belonging to another section task",async()=>{
 const f=setup({wrongTask:true});fireEvent.click(screen.getByText("Investigate refunds"));expect(await screen.findByText("You need a role on payments that can start work to see this step's details.")).toBeTruthy();expect(screen.queryByRole("tab",{name:"Plan"})).toBeNull();f.close();
});
