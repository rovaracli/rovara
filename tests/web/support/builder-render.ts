import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ApiRequest,ApiResponse } from "../../../packages/ui/src/host.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { BuilderScreen } from "../../../packages/ui/src/screens/builder/BuilderScreen.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { renderUi } from "./render.js";
import { h } from "./h.js";
import { fakeHost } from "./fake-host.js";
import { agentProfile,AGENT_FIXTURE_ID } from "./agent-fixture.js";
import { builderFixture } from "./builder-fixture.js";
export function renderBuilder(options:{path?:string;profile?:ReturnType<typeof agentProfile>;reply?:(request:ApiRequest)=>Promise<ApiResponse>;theme?:"light"|"dark";draft?:ReturnType<typeof builderFixture>;storage?:Record<string,string>}={}){
 let value=options.draft??builderFixture();const fake=fakeHost(async request=>{if(request.method!=="GET")return options.reply?.(request)??{status:200,body:{draft:{...value.draft,revision:value.draft.revision+1}}};if(request.path.endsWith("/versions"))return {status:200,body:{versions:[{version:3,current:true},{version:2}]}};if(request.path.includes("/diff?")){const url=new URL(request.path,"https://cell.example");return {status:200,body:{from:Number(url.searchParams.get("from")),to:Number(url.searchParams.get("to")),changes:["Review now uses claude-sonnet-4-6 instead of gpt-5.4"],lessSafe:[]}};}if(request.path.endsWith("/draft"))return {status:200,body:value};if(request.path==="/v1/app/agents/"+AGENT_FIXTURE_ID)return {status:200,body:options.profile??agentProfile()};if(request.path==="/v1/app/models")return {status:200,body:{models:[]}};if(request.path==="/v1/app/org/agent-guardrails")return {status:200,body:{guardrails:{maxAutonomy:"prepare"}}};if(request.path==="/v1/app/skills")return {status:200,body:{skills:[]}};return {status:404,body:{error:{code:"NOT_FOUND",message:"Not found."}}};});for(const [key,value] of Object.entries(options.storage??{}))fake.storage.set(key,value);const query=createQueryClient(),router=createMemoryRouter([{path:"/app/agents/:id/edit",element:h(BuilderScreen,{})}],{initialEntries:[options.path??"/app/agents/"+AGENT_FIXTURE_ID+"/edit"]});const ui=renderUi(h(AppHostProvider,{host:fake.host,children:h(QueryClientProvider,{client:query,children:h(RouterProvider,{router})})}),{theme:options.theme??"light"});return{...fake,...ui,query,router,setDraft(next:typeof value){value=next;},close(){ui.unmount();router.dispose();query.clear();}};
}
