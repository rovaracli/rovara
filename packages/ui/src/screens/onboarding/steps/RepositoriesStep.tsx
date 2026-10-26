import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { TextArea } from "../../../design/TextArea.js";
import { Select } from "../../../design/Select.js";
import { VisibleText } from "../../../design/VisibleText.js";
type Installation={installationId:number;accountLogin:string};
export function RepositoriesStep({installations,onCreated}:{installations:Installation[];onCreated:(name:string)=>void}){
 const api=useOnboardingApi(),[installation,setInstallation]=useState(installations[0]?.installationId??0),[repository,setRepository]=useState(""),[name,setName]=useState(""),[description,setDescription]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[intent,setIntent]=useState(()=>crypto.randomUUID());
 const repositories=useQuery({queryKey:["github","repositories",installation],enabled:installation>0,queryFn:()=>api.repositories(installation)});
 const changed=()=>setIntent(crypto.randomUUID());
 async function create(){setBusy(true);setError(undefined);try{const result=await api.create({requestId:intent,repository,...(name?{name}:{}),description});onCreated(result.project.definition.name);}catch(e){setError(e instanceof Error?e.message:"Couldn't create the project.");}finally{setBusy(false);}}
 return <><h2>Choose repositories</h2><p>Start with one repository. You'll review its setup before any work begins.</p><Select label="GitHub account" value={String(installation)} options={installations.map(item=>({value:String(item.installationId),label:item.accountLogin}))} onValueChange={value=>{setInstallation(Number(value));setRepository("");changed();}}/>{repositories.isPending?<p role="status">Loading repositories</p>:repositories.isError?<><p role="alert">Couldn't load repositories.</p><Button onClick={()=>{void repositories.refetch();}}>Try again</Button></>:<fieldset><legend>Repository</legend>{repositories.data.repositories.map(item=><label className="rv-onboarding-choice" key={item.githubRepositoryId}><input type="radio" name="repository" value={item.fullName} checked={repository===item.fullName} disabled={item.project!==undefined} onChange={()=>{setRepository(item.fullName);changed();}}/><VisibleText text={item.fullName}/>{item.project&&<span>Already in <VisibleText text={item.project}/></span>}</label>)}</fieldset>}<form onSubmit={event=>{event.preventDefault();void create();}}><TextField label="Project name" value={name} hint="Lowercase letters, numbers and hyphens. Leave blank to use the repository name." pattern="[a-z][a-z0-9-]{0,62}" maxLength={63} onChange={event=>{setName(event.target.value);changed();}}/><TextArea label="What is this project for?" value={description} maxLength={280} onChange={event=>{setDescription(event.target.value);changed();}}/><Button type="submit" variant="primary" busy={busy} disabled={!repository}>Create project</Button></form>{error&&<p role="alert"><VisibleText text={error}/></p>}</>;
}
