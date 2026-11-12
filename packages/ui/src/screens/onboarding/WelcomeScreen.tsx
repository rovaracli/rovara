import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useAppHost } from "../../host.js";
import { useOnboardingApi } from "../../api/onboarding.js";
import { Button } from "../../design/Button.js";
import { TextField } from "../../design/TextField.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { isPeopleV2On } from "../../people-flags.js";
import { JoinedLanding } from "../project/people/JoinedLanding.js";
import "./onboarding.css";
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
export function WelcomeScreen(){
 const host=useAppHost(),api=useOnboardingApi(),[params]=useSearchParams(),me=useQuery({queryKey:["me"],queryFn:api.me});
 const [name,setName]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[intent,setIntent]=useState(()=>crypto.randomUUID());
 const naming=me.data!==undefined&&me.data.developer.orgRole==="owner"&&me.data.org.nameIsDefault===true&&params.get("joined")!=="1";
 const joinedProject=params.get("project"),joinedNote=params.get("projectNote"),landing=isPeopleV2On(host)&&params.get("joined")==="1"&&((joinedProject!==null&&PROJECT_NAME.test(joinedProject))||joinedNote==="project_archived"||joinedNote==="project_gone");
 useEffect(()=>{if(me.data!==undefined&&!naming&&!landing)host.navigate("/app");},[host,me.data,naming,landing]);
 async function save(){setBusy(true);setError(undefined);try{await api.rename({requestId:intent,name});host.navigate("/app/onboard");}catch(e){setError(e instanceof Error?e.message:"Couldn't save the company name.");}finally{setBusy(false);}}
 return <main className="rv-entry rv-onboarding-entry">{me.isPending?<Skeleton label="Loading your account"/>:me.isError?<><PageHeader title="Couldn't load your account"/><Button onClick={()=>{void me.refetch();}}>Try again</Button></>:landing&&me.data!==undefined?<JoinedLanding company={me.data.org.name} project={joinedProject!==null&&PROJECT_NAME.test(joinedProject)?joinedProject:undefined} note={joinedNote==="project_archived"||joinedNote==="project_gone"?joinedNote:null}/>:naming?<><PageHeader title="Who are we working with?" description="Give your team's workspace a company name. You can change it later." focusOnMount/><form onSubmit={event=>{event.preventDefault();void save();}}><TextField label="Company name" value={name} maxLength={80} autoComplete="organization" onChange={event=>{setName(event.target.value);setIntent(crypto.randomUUID());}}/><Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Continue</Button></form>{error&&<p role="alert"><VisibleText text={error}/></p>}</>:<Skeleton label="Opening your workspace"/>}</main>;
}
