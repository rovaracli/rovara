import { AgentStatusCheck } from "./AgentStatusCheck.js";
import { useRef,useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBuilderApi } from "../../api/builder.js";
import { ApiError } from "../../api/errors.js";
import type { ReadAgent,ReadAgentProfile } from "../../api/agents.js";
import type { SendResult } from "../../api/client.js";
import { Dialog } from "../../design/Dialog.js";
import { Button } from "../../design/Button.js";
import { TextArea } from "../../design/TextArea.js";
import { VisibleText } from "../../design/VisibleText.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { failureText } from "../agents/agent-context.js";
import { agentAllows } from "../agents/agent-access.js";
import { RecipeDiffView,useRecipeDiff } from "./RecipeDiffView.js";
export function PublishDialog({agent,revision,disabled,onPublished,onInvalid}:{agent:ReadAgent;revision:number;disabled:boolean;onPublished:()=>void|Promise<void>;onInvalid:()=>void|Promise<void>}){
 const [open,setOpen]=useState(false),[note,setNote]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[published,setPublished]=useState<number>(),[pending,setPending]=useState<{result:Exclude<SendResult<unknown>,{kind:"done"}>;before:number;revision:number}>(),sending=useRef(false),receiptRevision=useRef<number|undefined>(undefined),intent=useRef<{body:string;id:string}|undefined>(undefined),api=useBuilderApi(),query=useQueryClient(),from=agent.currentVersion??"base",diff=useRecipeDiff(agent.agentId,from,"draft",open);
 if(agent.builtin||!agentAllows(agent,"edit"))return null;
 async function publish(){if(sending.current||pending||disabled||diff.isPending||diff.isError)return;sending.current=true;setBusy(true);setError(undefined);const body=JSON.stringify([revision,note]);if(intent.current?.body!==body)intent.current={body,id:crypto.randomUUID()};try{const result=await api.publish(agent.agentId,revision,note,intent.current.id);if(result.kind!=="done"){setPending({result,before:agent.currentVersion??0,revision});return;}receiptRevision.current=revision;setPublished(result.value.version.version);await onPublished();}catch(failure){setError(failureText(failure,"Couldn't publish this draft. Your note and edits are preserved."));if(failure instanceof ApiError&&failure.code==="CONFIG_INVALID"){try{await onInvalid();}catch{/* Preserve the original publication refusal. */}}}finally{sending.current=false;setBusy(false);}}
 return <Dialog title="Review and publish" open={open} onOpenChange={value=>{if(!busy){if(value&&published!==undefined&&receiptRevision.current!==revision){setPublished(undefined);setNote("");setError(undefined);intent.current=undefined;}setOpen(value);}}} trigger={<Button variant="primary" disabled={disabled&&!pending}>Publish</Button>}><p>Publishing changes the method used for new work. Existing sessions keep their recipe.</p><RecipeDiffView id={agent.agentId} from={from} to="draft"/><TextArea label="Version note" maxLength={200} value={note} disabled={busy||pending!==undefined||published!==undefined} onChange={event=>setNote(event.target.value)}/><Button variant="primary" busy={busy} disabled={disabled||pending!==undefined||published!==undefined||diff.isPending||diff.isError} onClick={()=>{void publish();}}>Publish this draft</Button>{error&&<p role="alert"><VisibleText text={error}/></p>}{published!==undefined&&<p role="status">Published version {published}</p>}{pending&&<>{pending.result.kind==="needs_confirmation"&&<ul>{pending.result.changes.map((change,index)=><li key={index}><VisibleText text={change}/></li>)}</ul>}<ConfirmInBrowser<ReadAgentProfile> result={pending.result} subjectKey={["agent",agent.agentId]} isApplied={view=>view.agent.currentVersion!==undefined&&view.agent.currentVersion>pending.before} onApplied={()=>{const fresh=query.getQueryData<ReadAgentProfile>(["agent",agent.agentId]);receiptRevision.current=pending.revision;setPublished(fresh?.agent.currentVersion);setPending(undefined);void onPublished();}}/><AgentStatusCheck id={agent.agentId}/></>}</Dialog>;
}
