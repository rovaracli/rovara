import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ReactElement } from "react";
import type { ApiRequest,ApiResponse } from "../../../packages/ui/src/host.js";
import { AppHostProvider } from "../../../packages/ui/src/host.js";
import { createQueryClient } from "../../../packages/ui/src/api/query.js";
import { renderUi } from "./render.js";
import { fakeHost } from "./fake-host.js";
import { h } from "./h.js";
import { agentProfile,agentDirectory,AGENT_FIXTURE_ID } from "./agent-fixture.js";
export async function renderPublish(element:ReactElement,options:{agentOnProject?:boolean;reply?:(request:ApiRequest)=>Promise<ApiResponse>;theme?:"light"|"dark"}={}){
 let profile=agentProfile();const fake=fakeHost(async request=>{if(request.method!=="GET")return options.reply?.(request)??{status:200,body:{agent:{...profile.agent,currentVersion:4,latestVersion:4},version:{version:4}}};const url=new URL(request.path,"https://cell.example");if(url.pathname.endsWith("/diff"))return {status:200,body:{from:url.searchParams.get("from")==="base"?"base":Number(url.searchParams.get("from")),to:url.searchParams.get("to")==="draft"?"draft":Number(url.searchParams.get("to")),changes:["Review now uses claude-sonnet-4-6 instead of gpt-5.4"],lessSafe:[]}};if(request.path.endsWith("/versions"))return {status:200,body:{versions:[{version:3,current:true,publishedAt:"2026-10-23T12:00:00.000Z",note:"Payment review"},{version:2,publishedAt:"2026-10-22T12:00:00.000Z",note:"Earlier method"}]}};if(request.path==="/v1/app/budget")return {status:200,body:{month:"2026-10",testing:{limitUsd:10,spentUsd:2,committedUsd:1}}};if(request.path==="/v1/app/projects")return {status:200,body:{projects:[{name:"payments",status:"active",latestRevision:1,repositories:[],myRole:"contributor",setup:{status:"ready"}}]}};if(request.path.startsWith("/v1/app/agents?"))return {status:200,body:options.agentOnProject===false?{agents:[]}:agentDirectory()};if(request.path==="/v1/app/org/members")return {status:200,body:{members:[]}};return {status:200,body:profile};});const query=createQueryClient();await query.fetchQuery({queryKey:["agent",AGENT_FIXTURE_ID],queryFn:async()=>profile});const ui=renderUi(h(AppHostProvider,{host:fake.host,children:h(QueryClientProvider,{client:query,children:h(MemoryRouter,{children:element})})}),{theme:options.theme??"light"});return{...fake,...ui,query,setProfile(next:typeof profile){profile=next;},close(){ui.unmount();query.clear();}};
}
