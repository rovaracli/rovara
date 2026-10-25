import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
export function AgentsStep({project,onNext}:{project:string;onNext:()=>void}){
 const api=useOnboardingApi(),agents=useQuery({queryKey:["agents","all",project],queryFn:()=>api.agents(project)}),[code,setCode]=useState(true),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[intent]=useState(()=>crypto.randomUUID());
 const available=useQuery({queryKey:["agents","all",undefined],queryFn:api.availableAgents});
 async function save(){setBusy(true);setError(undefined);try{if(code)await api.addAgent(project,"rovara-code",intent);for(const id of selected)await api.addAgent(project,id,intent);onNext();}catch(e){setError(e instanceof Error?e.message:"Couldn't add the agent.");}finally{setBusy(false);}}
 return <><h2>Agents</h2><p>Your project's roster is shared by the team. Start with Rovara Code; discover other shared workflows from the project later.</p><label className="rv-onboarding-choice"><input type="checkbox" checked={code} onChange={event=>setCode(event.target.checked)}/>Rovara Code</label>{agents.data?.agents.filter(agent=>!agent.builtin).map(agent=><p key={agent.agentId}><VisibleText text={agent.name}/> is already available.</p>)}{available.data?.agents.filter(agent=>!agent.builtin&&!agent.disabled&&agent.status==="active"&&!agents.data?.agents.some(onProject=>onProject.agentId===agent.agentId)).map(agent=><label className="rv-onboarding-choice" key={agent.agentId}><input type="checkbox" checked={selected.includes(agent.agentId)} onChange={event=>setSelected(value=>event.target.checked?[...value,agent.agentId]:value.filter(id=>id!==agent.agentId))}/><VisibleText text={agent.name}/></label>)}<Button variant="primary" busy={busy} onClick={()=>{void save();}}>Continue to teammates</Button>{error&&<p role="alert"><VisibleText text={error}/></p>}</>;
}
