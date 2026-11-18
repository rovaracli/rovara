import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useOnboardingApi } from "../../api/onboarding.js";
import { ProjectOverviewProjectSchema, type AppProjectDetail } from "@agentx/contracts/web";
import { PageHeader } from "../../design/PageHeader.js";
import { Skeleton } from "../../design/Skeleton.js";
import { Button } from "../../design/Button.js";
import { ConnectGithubStep } from "./steps/ConnectGithubStep.js";
import { GithubConnectResult, TRIAL_USED } from "./steps/GithubConnectResult.js";
import { AddToSlackStep, SlackConnectResult, useSlackWorkspace } from "../connect/SlackConnect.js";
import { LinearConnectResult } from "../connect/LinearConnect.js";
import { useAppHost } from "../../host.js";
import { RepositoriesStep } from "./steps/RepositoriesStep.js";
import { SetupStep } from "./steps/SetupStep.js";
import { AgentsStep } from "./steps/AgentsStep.js";
import { AiSpendStep } from "../setup/AiSpendStep.js";
import { ProjectChecklist } from "../setup/ProjectChecklist.js";
import { InviteStep } from "./steps/InviteStep.js";
import { FirstSessionStep } from "./steps/FirstSessionStep.js";
import "./onboarding.css";
// Guided onboarding PR 9 (design section 1): the company part, once, in four steps: Connect GitHub, Add to Slack (optional, "Set up later"), AI and spending,
// Pick repos. Picking repos lands on the new project's checklist (its page), which holds the per-project rows (setup run, checks, spend, channel, Linear,
// invites, first task). The Agents step is dropped from the guided path (DEC 254l item 6). The older single-project steps stay reachable by address
// (`?project=<p>&step=setup|agents|invite|first`): the checklist's "Edit commands" opens `step=setup`.
const steps=["Connect GitHub","Add to Slack","AI and spending","Pick repos"];
const keys=["github","slack","ai","repositories"];
const PROJECT_STEPS=["setup","agents","invite","first"];
/** "Set up later" for the optional Add to Slack step (DEC 254k): this browser's choice only; it never blocks, and Slack connected always shows as done. */
const SLACK_LATER_KEY="rovara.onboard.slack-later";
function useSlackLater(){
 const host=useAppHost(),[later,setLater]=useState(()=>{try{return host.storage.get(SLACK_LATER_KEY)==="1";}catch{return false;}});
 const set=(value:boolean)=>{setLater(value);try{host.storage.set(SLACK_LATER_KEY,value?"1":"");}catch{/* Blocked storage: the step shows again next time. */}};
 return [later,set] as const;
}
export function OnboardScreen(){
 const [slackLater,setSlackLater]=useSlackLater(),navigate=useNavigate();
 const api=useOnboardingApi(),query=useQueryClient(),[params,setParams]=useSearchParams(),me=useQuery({queryKey:["me"],queryFn:api.me}),canAdd=me.data?.developer.orgRole==="owner"||me.data?.developer.orgRole==="admin";
 const installations=useQuery({queryKey:["github","installations"],enabled:canAdd,queryFn:api.installations}),active=installations.data?.installations.filter(item=>item.status==="active")??[];
 // Guided onboarding PR 2: the company's connected GitHub accounts (Code's read): the step is Done from real state, not a saved position.
 const connections=useQuery({queryKey:["github","connections"],enabled:canAdd,queryFn:api.githubConnections,retry:false}),githubDone=(connections.data?.installations.length??0)>0||active.length>0,githubOutcome=params.get("github")??"";
 const slack=useSlackWorkspace(canAdd),slackDone=slack.data?.workspace?.state==="connected";
 const rawProject=params.get("project"),valid=ProjectOverviewProjectSchema.shape.name.safeParse(rawProject),projectName=valid.success?valid.data:undefined;
 const projectStep=projectName===undefined?-1:PROJECT_STEPS.indexOf(params.get("step")??"");
 const project=useQuery({queryKey:["onboard","project",projectName],enabled:canAdd&&projectName!==undefined&&projectStep>=0,queryFn:()=>api.project(projectName!)}),[polls,setPolls]=useState(0);
 const setupStatus=project.data?.setup.status,polledAt=project.dataUpdatedAt,pollProject=project.refetch;
 useEffect(()=>{if(setupStatus!=="checking"||polls>=30)return;const timer=setTimeout(()=>{setPolls(value=>value+1);void pollProject();},2000);return()=>clearTimeout(timer);},[setupStatus,polledAt,polls,pollProject]);
 const requested=keys.indexOf(params.get("step")??"");
 // The first company step that isn't done, from real state; a step asked for by address is shown once GitHub is connected (nothing works without code).
 // GitHub counts as ready once an installation is active (its repos can be listed); a connection alone marks the step Done.
 const githubReady=active.length>0,firstOpen=!githubReady?0:!slackDone&&!slackLater?1:2;
 // Back from Slack (`slack=<word>`): the Slack step shows its outcome.
 const step=!githubReady&&requested!==0?0:requested>=0?requested:params.has("slack")?1:firstOpen;
 function go(index:number){const next=new URLSearchParams();next.set("step",keys[index]!);setParams(next);}
 function goProject(index:number,name=projectName){const next=new URLSearchParams();if(name)next.set("project",name);next.set("step",PROJECT_STEPS[index]!);setParams(next);}
 function update(value:AppProjectDetail){query.setQueryData(["onboard","project",value.name],value);setPolls(0);}
 if(me.isPending)return <Skeleton label="Loading onboarding"/>;
 if(me.isError)return <section><PageHeader title="Couldn't load your account"/><Button onClick={()=>{void me.refetch();}}>Try again</Button></section>;
 // A person who is not an owner or admin: the company member list is admin-only on Code (a plain member is answered 404 by design), so it is never asked for here and no admin is named.
 if(!canAdd)return <section><PageHeader title="Onboard a project" focusOnMount/><p>Only owners and admins can add projects. Ask your organization owner or an admin to add one.</p></section>;
 const results=<>{githubOutcome==="trial_used"&&<aside className="rv-trial-banner"><p>{TRIAL_USED}</p></aside>}<GithubConnectResult outcome={githubOutcome}/><SlackConnectResult outcome={params.get("slack")??""}/><LinearConnectResult outcome={params.get("linear")??""}/></>;
 // A project: its checklist, or one of the older single-project steps asked for by address.
 if(projectName!==undefined){
  const back=<p><Link to={"/app/projects/"+encodeURIComponent(projectName)}>Back to the project's checklist</Link></p>;
  if(projectStep<0)return <section className="rv-onboarding"><PageHeader title={"Set up "+projectName} focusOnMount/>{results}<ProjectChecklist project={projectName} place="onboard"/><p><Link to={"/app/projects/"+encodeURIComponent(projectName)}>Open the project</Link></p></section>;
  return <section className="rv-onboarding"><PageHeader title={"Set up "+projectName} focusOnMount/>{results}{back}<div className="rv-onboarding-workspace" key={projectName}>{project.isPending?<Skeleton label="Loading your project"/>:project.isError?<><p role="alert">Couldn't load this project.</p><Button onClick={()=>{void project.refetch();}}>Try again</Button></>:projectStep===0&&project.data?<SetupStep key={projectName} project={project.data} onProject={update} refresh={()=>{setPolls(0);void project.refetch();}} onNext={()=>goProject(1)}/>:projectStep===1?<AgentsStep project={projectName} onNext={()=>goProject(2)}/>:projectStep===2?<InviteStep onNext={()=>goProject(3)}/>:<FirstSessionStep project={projectName} ready={project.data?.setup.status==="ready"}/>}</div></section>;
 }
 const done=[githubDone,slackDone,false,false];
 return <section className="rv-onboarding"><PageHeader title="Set up your company" description="Connect your code, choose how Rovara pays for AI, then pick the repos to work on." focusOnMount/>{results}<nav aria-label="Onboarding progress"><p className="rv-onboarding-count">Step {step+1} of {steps.length}</p><ol>{steps.map((label,index)=><li key={label} aria-current={index===step?"step":undefined} data-testid={`onboard-step-${keys[index]!}`}><span>{index+1}</span>{label}{index===1&&<em className="rv-connect-optional"> Optional</em>}{done[index]&&<em className="rv-step-done"> Done</em>}{index===1&&!slackDone&&slackLater&&<em className="rv-step-done"> Skipped (optional)</em>}</li>)}</ol></nav><div className="rv-onboarding-workspace">{installations.isPending?<Skeleton label="Checking your GitHub connection"/>:installations.isError?<><p role="alert">Couldn't check your GitHub connection.</p><Button onClick={()=>{void installations.refetch();}}>Try again</Button></>:step===0?<ConnectGithubStep requested={githubOutcome==="requested"} done={githubDone} refresh={()=>{void installations.refetch();void connections.refetch();}}/>:step===1?<><AddToSlackStep skipped={slackLater} onSkip={()=>{setSlackLater(true);go(1);}} onUndoSkip={()=>setSlackLater(false)}/>{(slackDone||slackLater)&&<Button variant="primary" data-testid="onboard-continue-ai" onClick={()=>go(2)}>Continue</Button>}</>:step===2?<><AiSpendStep role={me.data.developer.orgRole==="owner"?"owner":"admin"} developerId={me.data.developer.id} onSaved={()=>go(3)}/><Button data-testid="onboard-continue-repos" onClick={()=>go(3)}>Continue to pick repos</Button></>:<RepositoriesStep installations={active} onCreated={name=>{void navigate("/app/projects/"+encodeURIComponent(name));}}/>}</div></section>;
}
