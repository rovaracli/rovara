import { useRef, useState } from "react";
import { Link } from "react-router";
import { AGENT_NAME_MAX, AGENT_DESCRIPTION_MAX } from "@agentx/cloud-contracts/web";
import { useAgents } from "../../api/agents.js";
import { useBuilderApi } from "../../api/builder.js";
import { useAppHost } from "../../host.js";
import { PageHeader } from "../../design/PageHeader.js";
import { TextField } from "../../design/TextField.js";
import { TextArea } from "../../design/TextArea.js";
import { Select } from "../../design/Select.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { LargerScreen } from "../../shell/LargerScreen.js";
import { failureText } from "../agents/agent-context.js";
import { paths } from "../../paths.js";
import "./builder.css";
export function NewAgentScreen(){const[choice,setChoice]=useState("code"),[template,setTemplate]=useState(""),[name,setName]=useState(""),[description,setDescription]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),sending=useRef(false),intent=useRef<{body:string;id:string}|undefined>(undefined),api=useBuilderApi(),host=useAppHost(),builtins=useAgents("builtin");
 async function create(){if(sending.current||!name.trim()||(choice==="template"&&!template))return;sending.current=true;setBusy(true);setError(undefined);const body={name:name.trim(),description,...(choice==="scratch"?{overlay:{sequence:[{id:"work",name:"Work",kind:"agent" as const,workspace:"none" as const}]}}:{extends:choice==="code"?"rovara-code":template})},serialized=JSON.stringify(body);if(intent.current?.body!==serialized)intent.current={body:serialized,id:crypto.randomUUID()};try{const result=await api.create(body,intent.current.id);if(result.kind==="done")host.navigate(paths.agentEdit(result.value.agent.agentId));else setError("Creation needs confirmation. The draft is not ready yet.");}catch(failure){setError(failureText(failure,"Couldn't create this agent. Your inputs are still here."));}finally{sending.current=false;setBusy(false);}}
 return <LargerScreen backTo={{href:paths.directory,label:"Back to the agent directory"}}><section className="rv-builder"><PageHeader title="Create a shared method" description="Start with a proven structure, then make the team's judgment explicit."/><fieldset className="rv-builder-choices" disabled={busy}><legend>Choose your starting point</legend>{[{value:"code",title:"Build on Rovara Code",text:"Keep its coding recipe and add your team's instructions."},{value:"template",title:"Start from a template",text:"Adapt a built-in method to the work you do."},{value:"scratch",title:"Start from scratch",text:"Define a sequence of agent and approval steps."}].map(item=><label key={item.value}><input type="radio" name="starting-point" value={item.value} checked={choice===item.value} onChange={()=>setChoice(item.value)}/><span><strong>{item.title}</strong><span>{item.text}</span></span></label>)}</fieldset>{choice==="template"&&<Select label="Template" value={template} onValueChange={setTemplate} disabled={builtins.isPending||builtins.isError||busy} options={(builtins.isError?[]:builtins.data?.agents??[]).filter(agent=>agent.builtin&&agent.agentId!=="rovara-code"&&!agent.disabled).map(agent=>({value:agent.agentId,label:agent.name}))}/>}<TextField label="Agent name" maxLength={AGENT_NAME_MAX} value={name} disabled={busy} onChange={event=>setName(event.target.value)}/><TextArea label="Description" maxLength={AGENT_DESCRIPTION_MAX} value={description} disabled={busy} onChange={event=>setDescription(event.target.value)}/><Button variant="primary" busy={busy} disabled={!name.trim()||name.length>AGENT_NAME_MAX||(choice==="template"&&!template)} onClick={()=>{void create();}}>Create draft</Button> <Link to={paths.directory}>Back to workflows</Link>{error&&<p role="alert"><VisibleText text={error}/></p>}</section></LargerScreen>;
}
