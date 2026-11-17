// Guided onboarding PR 2: what the GitHub callback came back with. The landing address carries one fixed word (`github=`); the outcome itself
// (an account name, a list to choose from) is kept by Cloud's server for this sign-in and read once. Refusals are Code's fixed sentences, each
// with "Try again".
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useGithubConnect } from "./ConnectGithubStep.js";

export const GITHUB_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
 start_again: "Start again from Rovara.",
 taken: "This GitHub account is already connected to a different Rovara company.",
 unavailable: "GitHub could not be connected just now. Start again from Rovara.",
 not_available: "Connecting GitHub isn't available yet.",
});
export const TRIAL_USED = "This GitHub account already started a free trial for another organization. Connect a different GitHub account, or ask us about a plan.";
const ROW_STATES = { this_company: "It's already connected to this company.", another_company: "It's connected to a different Rovara company.", suspended: "It's suspended on GitHub." } as const;

function Retry({message}:{message:string}){
 const github=useGithubConnect();
 return <div data-testid="github-refused"><p role="alert" data-testid="github-refused-message"><VisibleText text={message}/></p><Button variant="primary" busy={github.busy} data-testid="github-try-again" onClick={()=>{void github.start("install");}}>Try again</Button>{github.error&&<p role="alert"><VisibleText text={github.error}/></p>}</div>;
}

function Connected({login,trialUsed}:{login:string;trialUsed:boolean}){
 return <><p role="status" data-testid="github-connected">Connected to <strong><VisibleText text={login}/></strong></p>{trialUsed&&<aside className="rv-trial-banner" data-testid="github-trial-used"><p>{TRIAL_USED}</p></aside>}</>;
}

export function GithubConnectResult({outcome}:{outcome:string}){
 const api=useOnboardingApi(),host=useAppHost(),query=useQueryClient();
 const [chosen,setChosen]=useState<{login:string;trialUsed:boolean}>(),[choosing,setChoosing]=useState<number>(),[chooseError,setChooseError]=useState<string>(),[copied,setCopied]=useState(false);
 const refusal=GITHUB_REFUSALS[outcome];
 const result=useQuery({queryKey:["github","connect-result"],enabled:outcome==="result",queryFn:async()=>{const value=await api.githubResult();if(value.status==="connected")void query.invalidateQueries({queryKey:["github"],predicate:item=>item.queryKey[1]!=="connect-result"});return value;},retry:false,staleTime:Infinity,gcTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false});
 async function choose(installationId:number){setChoosing(installationId);setChooseError(undefined);try{const value=await api.githubChoose(installationId);setChosen({login:value.accountLogin,trialUsed:value.trialUsed===true});void query.invalidateQueries({queryKey:["github"],predicate:item=>item.queryKey[1]!=="connect-result"});}catch(e){setChooseError(e instanceof Error?e.message:GITHUB_REFUSALS.start_again);}finally{setChoosing(undefined);}}
 async function copy(link:string){try{if(host.copyText===undefined)throw new Error("Clipboard unavailable.");await host.copyText(link);setCopied(true);}catch{setCopied(false);}}
 if(refusal!==undefined)return <section className="rv-github-result" aria-label="GitHub connection"><Retry message={refusal}/></section>;
 if(outcome!=="result"||result.isPending||result.isError)return null;
 const value=result.data;
 if(chosen!==undefined)return <section className="rv-github-result" aria-label="GitHub connection"><Connected login={chosen.login} trialUsed={chosen.trialUsed}/></section>;
 if(chooseError!==undefined)return <section className="rv-github-result" aria-label="GitHub connection"><Retry message={chooseError}/></section>;
 if(value.status==="connected")return <section className="rv-github-result" aria-label="GitHub connection"><Connected login={value.accountLogin} trialUsed={value.trialUsed===true}/></section>;
 if(value.status==="requested")return <section className="rv-github-result" aria-label="GitHub connection" data-testid="github-requested"><p role="status">Request sent. We'll show it here when your GitHub admin approves.</p>{value.adminUrl!==undefined&&<><p>Send your GitHub admin this link to approve Rovara:</p><p><input className="rv-github-admin-link" aria-label="Link for your GitHub admin" readOnly value={value.adminUrl} data-testid="github-admin-link"/></p><Button data-testid="github-copy-admin-link" onClick={()=>{void copy(value.adminUrl!);}}>{copied?"Link copied":"Copy link"}</Button></>}</section>;
 if(value.status==="choose")return <section className="rv-github-result" aria-label="GitHub connection" data-testid="github-choose"><ul className="rv-github-choices">{value.installations.map(row=>{const blocked=row.suspended?"suspended":row.connection==="unbound"?undefined:row.connection==="this_company"||row.connection==="another_company"?row.connection:"another_company";return <li key={row.installationId} data-testid="github-choice"><p>We found Rovara on <strong><VisibleText text={row.accountLogin}/></strong>. {blocked===undefined?"Connect it?":ROW_STATES[blocked]}</p>{blocked===undefined&&<Button variant="primary" busy={choosing===row.installationId} disabled={choosing!==undefined} onClick={()=>{void choose(row.installationId);}}>Connect it</Button>}</li>;})}</ul>{value.installations.length===0&&<p>We didn't find Rovara on a GitHub account you manage. Install it first.</p>}</section>;
 return null;
}
