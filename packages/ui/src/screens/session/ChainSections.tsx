import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChainRunViewReaderSchema, SessionStepTaskResponseReaderSchema } from "@agentx/cloud-contracts/web";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isConfirmUrl } from "../../text/links.js";
import { Workspace } from "./Workspace.js";
import type { ReadSession } from "./SessionHeader.js";
type ReadSection = ReturnType<typeof ChainRunViewReaderSchema.parse>["sections"][number];
const states: Record<string,string> = { starting:"Starting",running:"Working",waiting:"Waiting for a decision",paused:"Paused",succeeded:"Finished",failed:"Failed",cancelled:"Cancelled",timed_out:"Timed out" };
export function ChainSections({session}:{session:ReadSession}) {
 const parsed=ChainRunViewReaderSchema.safeParse(session.body.kind==="chain"?session.body.chain:undefined);
 if(!parsed.success)return <p className="rv-muted">Details aren't available for this session.</p>;
 return <section aria-label="Chain progress"><ol className="rv-run-steps">{parsed.data.sections.map(section=><ChainSection key={session.sessionId+":"+section.seq} session={session} section={section}/>)}</ol></section>;
}
function ChainSection({session,section}:{session:ReadSession;section:ReadSection}) {
 const host=useAppHost(),location=useLocation(),navigate=useNavigate(),prefix="#step-"+section.seq+"-",[expanded,setExpanded]=useState(false),gate=section.gate;
 const open=expanded||location.hash.startsWith(prefix);
 const confirm=gate?.status==="PENDING"&&gate.confirmUrl!==undefined&&!gate.confirmUrl.includes("?")&&isConfirmUrl(gate.confirmUrl,host.origin)?gate.confirmUrl:undefined;
 return <li><details open={open} onToggle={event=>{const expanded=event.currentTarget.open;setExpanded(expanded);if(!expanded&&location.hash.startsWith(prefix))void navigate({...location,hash:"#pipeline"},{replace:true,preventScrollReset:true});}}><summary><VisibleText text={section.name}/><span className="rv-muted"> {states[section.status]??"Status unavailable"}</span></summary>
 {section.agent&&<p><VisibleText text={section.agent.name}/> · version {section.agent.version}</p>}
 {section.costUsd!==undefined&&<p>Spent <Money usd={section.costUsd}/></p>}
 {section.report!==undefined&&<p className="rv-evidence-text"><VisibleText text={section.report}/></p>}
 {gate&&<div><p><VisibleText text={gate.prompt}/></p><p><VisibleText text={gate.approvers}/></p><p>{({PENDING:"Waiting for a decision",APPROVED:"Approved",DECLINED:"Declined",EXPIRED:"Expired"} as Record<string,string>)[gate.status]??"Status unavailable"}</p>{confirm&&<Button onClick={()=>host.openExternal(confirm)}>Open</Button>}</div>}
 {open&&section.detail?.kind==="task"&&<SectionTask session={session} seq={section.seq} taskId={section.detail.taskId}/>}
 </details></li>;
}
function SectionTask({session,seq,taskId}:{session:ReadSession;seq:number;taskId:string}) {
 const host=useAppHost(),api=useMemo(()=>createApiClient(host),[host]);
 const query=useQuery({queryKey:["session",session.sessionId,"section",seq,taskId],queryFn:async()=>{
 const result=await api.get("/v1/app/sessions/"+encodeURIComponent(session.sessionId)+"/sections/"+seq+"/task",SessionStepTaskResponseReaderSchema);
 if(result.task.taskId!==taskId||result.task.project!==session.project)throw new ApiError(404,"NOT_FOUND","Not found.");
 return result.task;
 }});
 if(query.isError)return <p role="status">{query.error instanceof ApiError&&query.error.status===404?<VisibleText text={"You need a role on "+(session.project??"this project")+" that can start work to see this step's details."}/>:<>This step's details couldn't be loaded. <Button variant="quiet" onClick={()=>{void query.refetch();}}>Try again</Button></>}</p>;
 if(query.isPending)return <p role="status">Loading step details…</p>;
 // Chain step tasks are the owning backend's read-only projection; gate decisions stay on the chain.
 return <Workspace section={seq} session={{...session,kind:"task",you:{...session.you,owner:false,actions:[]},anchors:[],body:{kind:"task",task:query.data}}}/>;
}
