import { useRef,useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ProjectRoleSchema,projectAllows,SessionIdSchema } from "@agentx/contracts/web";
import type { ReadAgent } from "../../api/agents.js";
import { useBuilderApi } from "../../api/builder.js";
import type { SendResult } from "../../api/client.js";
import { useAppHost } from "../../host.js";
import { workPlace } from "../../nav-flags.js";
import { Dialog } from "../../design/Dialog.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { Money } from "../../design/Money.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { agentAllows } from "../agents/agent-access.js";
import { useAgentProjects,failureText } from "../agents/agent-context.js";
import { Link } from "react-router";
// RULING Q51: the owning broker allows draft tests off-roster; project start permission still applies.
export function TestRunDialog({agent,disabled,initialOpen=false}:{agent:ReadAgent;disabled:boolean;initialOpen?:boolean}){
 const [open,setOpen]=useState(initialOpen),[project,setProject]=useState(""),[text,setText]=useState(""),[busy,setBusy]=useState(false),[accepted,setAccepted]=useState(false),[error,setError]=useState<string>(),[pending,setPending]=useState<Exclude<SendResult<unknown>,{kind:"done"}>>(),sending=useRef(false),intent=useRef<{body:string;id:string}|undefined>(undefined),api=useBuilderApi(),host=useAppHost(),place=workPlace(host),projects=useAgentProjects(open),budget=useQuery({queryKey:["budget","testing"],enabled:open,queryFn:()=>api.testing()});
 if(agent.builtin||!agentAllows(agent,"edit"))return null;const eligible=(projects.isError?[]:projects.data?.projects??[]).filter(item=>{const role=ProjectRoleSchema.safeParse(item.myRole);return item.status==="active"&&role.success&&projectAllows(role.data,"start_tasks");}),limit=budget.isError?undefined:budget.data?.testing.limitUsd,cap=budget.isError?undefined:budget.data?.perTestCapUsd,remaining=limit===undefined?undefined:Math.max(0,limit-(budget.data?.testing.committedUsd??0));
 async function run(){if(sending.current||disabled||accepted||pending||!eligible.some(item=>item.name===project)||!text.trim()||text.length>4000||remaining===undefined||cap===undefined)return;sending.current=true;setBusy(true);setError(undefined);const body=JSON.stringify([project,text]);if(intent.current?.body!==body)intent.current={body,id:crypto.randomUUID()};try{const result=await api.test(agent.agentId,project,text,intent.current.id);if(result.kind!=="done"){setPending(result);return;}setAccepted(true);const session=SessionIdSchema.safeParse(result.value.task.sessionId);if(session.success)host.navigate("/app/sessions/"+session.data);}catch(failure){setError(failureText(failure,"Couldn't start this test. Your task is preserved."));}finally{sending.current=false;setBusy(false);}}
 return <Dialog title="Test this draft" open={open} onOpenChange={value=>{if(!busy)setOpen(value);}} trigger={<Button disabled={disabled}>Test draft</Button>}><p>This runs real work against the current saved draft and uses your testing allowance.</p>{remaining===undefined?<p>{budget.isError?"Couldn't read your testing allowance.":"Loading testing allowance"}</p>:<p>Testing allowance left: <Money usd={remaining}/></p>}{/* RULING Q52: a configurable company cap must come from the server, never a default. */}{cap===undefined?(budget.isPending?<p>Loading test spending limit</p>:<p>The test spending limit is unavailable. Refresh before starting a paid test.</p>):<p>Per-test cap: <Money usd={cap}/></p>}{!budget.isPending&&(cap===undefined||budget.isError)&&<Button onClick={()=>{void budget.refetch();}}>Refresh spending limits</Button>}<Select label="Project" value={project} onValueChange={setProject} disabled={busy||accepted||pending!==undefined||projects.isError} options={eligible.map(item=>({value:item.name,label:item.name}))}/><TextArea label="Task for this test" maxLength={4000} value={text} disabled={busy||accepted||pending!==undefined} onChange={event=>setText(event.target.value)}/><Button variant="primary" busy={busy} disabled={disabled||accepted||pending!==undefined||!project||!text.trim()||remaining===undefined||cap===undefined} onClick={()=>{void run();}}>Run test</Button>{error&&<p role="alert"><VisibleText text={error}/></p>}{accepted&&<p role="status">The test was accepted. <Link to={place.path}>Open {place.name}</Link> to find its session.</p>}{pending&&<ConfirmInBrowser result={pending} subjectKey={["agent",agent.agentId]} isApplied={()=>false}/>}</Dialog>;
}
