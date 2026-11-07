import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { useOnboardingApi } from "../../api/onboarding.js";
import { ProjectOverviewProjectSchema, type AppProjectDetail } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Button } from "../../design/Button.js";
import { ConnectGithubStep } from "./steps/ConnectGithubStep.js";
import { RepositoriesStep } from "./steps/RepositoriesStep.js";
import { SetupStep } from "./steps/SetupStep.js";
import { AgentsStep } from "./steps/AgentsStep.js";
import { InviteStep } from "./steps/InviteStep.js";
import { FirstSessionStep } from "./steps/FirstSessionStep.js";
import "./onboarding.css";
const steps=["Connect GitHub","Choose repositories","Setup","Agents","Invite teammates","First session"];
/** UX-4b: how the page follows a running check. Every 2 s for the first minute, then every 15 s, for as long as a check can run (the broker fails one that stalls at 50 minutes). */
export const POLL_FAST_MS=2000,POLL_SLOW_MS=15_000,POLL_FAST_COUNT=30,POLL_FOR_MS=55*60_000;
export const pollDelay=(polls:number,elapsedMs:number):number|undefined=>elapsedMs>=POLL_FOR_MS?undefined:polls<POLL_FAST_COUNT?POLL_FAST_MS:POLL_SLOW_MS;
const keys=["github","repositories","setup","agents","invite","first"];
export function OnboardScreen(){
 const navigate=useNavigate(),api=useOnboardingApi(),query=useQueryClient(),[params,setParams]=useSearchParams(),me=useQuery({queryKey:["me"],queryFn:api.me}),canAdd=me.data?.developer.orgRole==="owner"||me.data?.developer.orgRole==="admin";
 const members=useQuery({queryKey:["org","members"],enabled:me.data!==undefined&&!canAdd,queryFn:api.members});
 const installations=useQuery({queryKey:["github","installations"],enabled:canAdd,queryFn:api.installations}),active=installations.data?.installations.filter(item=>item.status==="active")??[];
 const rawProject=params.get("project"),valid=ProjectOverviewProjectSchema.shape.name.safeParse(rawProject),projectName=valid.success?valid.data:undefined;
 // UX-4b: a project's maintainer reaches its setup here too (every setup route needs only a maintainer); the other steps stay an owner's or admin's.
 const project=useQuery({queryKey:["onboard","project",projectName],enabled:me.data!==undefined&&projectName!==undefined,retry:false,queryFn:()=>api.project(projectName!)}),[polls,setPolls]=useState(0),[pollStart,setPollStart]=useState(()=>Date.now());
 const maintainerOnly=!canAdd&&projectName!==undefined&&project.data?.myRole==="maintainer";
 const setupStatus=project.data?.setup.status,polledAt=project.dataUpdatedAt,pollProject=project.refetch;
 useEffect(()=>{if(setupStatus!=="checking")return;const delay=pollDelay(polls,Date.now()-pollStart);if(delay===undefined)return;const timer=setTimeout(()=>{setPolls(value=>value+1);void pollProject();},delay);return()=>clearTimeout(timer);},[setupStatus,polledAt,polls,pollProject,pollStart]);
 // UX-4b: a later step is reached only once setup is ready; `?step=agents` (or invite, first) no longer skips a setup that isn't.
 const ready=project.data?.setup.status==="ready",requested=keys.indexOf(params.get("step")??""),step=projectName!==undefined?(maintainerOnly?2:Math.max(2,requested<0?(ready?3:2):!ready&&requested>2?2:requested)):active.length>0?1:0;
 function go(index:number,name=projectName){const next=new URLSearchParams();if(name)next.set("project",name);next.set("step",keys[index]!);setParams(next);}
 function update(value:AppProjectDetail){query.setQueryData(["onboard","project",value.name],value);setPolls(0);setPollStart(Date.now());}
 if(me.isPending)return <Skeleton label="Loading onboarding"/>;
 if(me.isError)return <section><PageHeader title="Couldn't load your account"/><Button onClick={()=>{void me.refetch();}}>Try again</Button></section>;
 if(projectName!==undefined&&!canAdd&&project.isPending)return <Skeleton label="Loading your project"/>;
 if(maintainerOnly&&project.data)return <section className="rv-onboarding"><PageHeader title={"Set up "+project.data.name} description="Make the environment reproducible for everyone who works on this project." focusOnMount/><div className="rv-onboarding-workspace" key={projectName}><SetupStep key={projectName} project={project.data} onProject={update} refresh={()=>{setPolls(0);setPollStart(Date.now());void project.refetch();}} onNext={()=>{void navigate("/app/projects/"+encodeURIComponent(project.data.name));}} nextLabel="Back to the project"/></div></section>;
 if(!canAdd)return <section><PageHeader title="Onboard a project" focusOnMount/>{members.isPending?<Skeleton label="Loading your admins"/>:members.isError?<><p role="alert">Couldn't load your organization's admins.</p><Button onClick={()=>{void members.refetch();}}>Try again</Button></>:<p>Only owners and admins can add projects. Ask <VisibleText text={members.data.members.filter(member=>member.role==="owner"||member.role==="admin").map(member=>member.name).join(", ")||"your organization owner"}/> to add one.</p>}</section>;
 return <section className="rv-onboarding"><PageHeader title="Onboard a project" description="A reproducible setup. Shared workflows. One place to work together." focusOnMount/>{params.get("github")==="trial_used"&&<aside className="rv-trial-banner"><p>This GitHub account already started a free trial for another organization. Connect a different GitHub account, or ask us about a plan.</p></aside>}<nav aria-label="Onboarding progress"><p className="rv-onboarding-count">Step {step+1} of 6</p><ol>{steps.map((label,index)=><li key={label} aria-current={index===step?"step":undefined}><span>{index+1}</span>{label}</li>)}</ol></nav><div className="rv-onboarding-workspace" key={projectName??"new"}>{installations.isPending?<Skeleton label="Checking your GitHub connection"/>:installations.isError?<><p role="alert">Couldn't check your GitHub connection.</p><Button onClick={()=>{void installations.refetch();}}>Try again</Button></>:projectName&&project.isPending?<Skeleton label="Loading your project"/>:projectName&&project.isError?<><p role="alert">Couldn't load this project.</p><Button onClick={()=>{void project.refetch();}}>Try again</Button></>:step===0?<ConnectGithubStep requested={params.get("github")==="requested"} refresh={()=>{void installations.refetch();}}/>:step===1?<RepositoriesStep installations={active} onCreated={name=>go(2,name)}/>:step===2&&project.data?<SetupStep key={projectName} project={project.data} onProject={update} refresh={()=>{setPolls(0);setPollStart(Date.now());void project.refetch();}} onNext={()=>go(3)}/>:step===3&&projectName?<AgentsStep project={projectName} onNext={()=>go(4)}/>:step===4?<InviteStep onNext={()=>go(5)}/>:projectName?<FirstSessionStep project={projectName} ready={project.data?.setup.status==="ready"}/>:null}</div></section>;
}
