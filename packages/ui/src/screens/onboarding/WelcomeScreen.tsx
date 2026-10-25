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
import "./onboarding.css";
export function WelcomeScreen(){
 const host=useAppHost(),api=useOnboardingApi(),[params]=useSearchParams(),me=useQuery({queryKey:["me"],queryFn:api.me});
 const [name,setName]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[intent,setIntent]=useState(()=>crypto.randomUUID());
 const naming=me.data!==undefined&&me.data.developer.orgRole==="owner"&&me.data.org.nameIsDefault===true&&params.get("joined")!=="1";
 useEffect(()=>{if(me.data!==undefined&&!naming)host.navigate("/app");},[host,me.data,naming]);
 async function save(){setBusy(true);setError(undefined);try{await api.rename({requestId:intent,name});host.navigate("/app/onboard");}catch(e){setError(e instanceof Error?e.message:"Couldn't save the company name.");}finally{setBusy(false);}}
 return <main className="rv-entry rv-onboarding-entry">{me.isPending?<Skeleton label="Loading your account"/>:me.isError?<><PageHeader title="Couldn't load your account"/><Button onClick={()=>{void me.refetch();}}>Try again</Button></>:naming?<><PageHeader title="Who are we working with?" description="Give your team's workspace a company name. You can change it later." focusOnMount/><form onSubmit={event=>{event.preventDefault();void save();}}><TextField label="Company name" value={name} maxLength={80} autoComplete="organization" onChange={event=>{setName(event.target.value);setIntent(crypto.randomUUID());}}/><Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Continue</Button></form>{error&&<p role="alert"><VisibleText text={error}/></p>}</>:<Skeleton label="Opening your workspace"/>}</main>;
}
