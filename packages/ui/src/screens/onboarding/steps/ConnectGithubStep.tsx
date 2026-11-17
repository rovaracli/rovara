import { useState } from "react";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { useAppHost } from "../../../host.js";
import { isGithubAuthorizeUrl, isGithubInstallationUrl } from "../../../text/links.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
/** Starts Connect GitHub (guided onboarding PR 2): Cloud's server asks Code for a state, binds it to this browser, and answers GitHub's page to open. */
export function useGithubConnect(){
 const api=useOnboardingApi(),host=useAppHost(),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 async function start(where:"install"|"authorize"){setBusy(true);setError(undefined);try{const result=await api.connect();const target=where==="authorize"?result.authorizeUrl:result.installUrl;if(target===undefined||!(where==="authorize"?isGithubAuthorizeUrl(target):isGithubInstallationUrl(target)))throw new Error("Rovara returned an invalid GitHub link.");host.navigate(target);}catch(e){setError(e instanceof Error?e.message:"Couldn't connect GitHub.");setBusy(false);}}
 return {busy,error,start};
}
// RULING Q54: preserve linked-identity requirements; deliberate sign-in recovery never links accounts in this screen.
export function ConnectGithubStep({requested,refresh,done}:{requested:boolean;refresh:()=>void;done?:boolean}){
 const host=useAppHost(),github=useGithubConnect(),[help,setHelp]=useState(false);
 return <><h2>Connect GitHub</h2>{done?<p role="status" data-testid="github-step-done">GitHub is connected.</p>:<p>Choose the repositories this workspace can work on. GitHub will ask you to review access before you connect.</p>}{requested&&<p role="status">We'll tell you when your GitHub admin approves it.</p>}<Button variant="primary" busy={github.busy} data-testid="github-connect" onClick={()=>{void github.start("install");}}>Connect GitHub</Button><Button busy={github.busy} data-testid="github-connect-existing" onClick={()=>{void github.start("authorize");}}>Rovara is already on GitHub</Button><Button onClick={()=>setHelp(!help)}>Ask my GitHub admin</Button>{help&&<p>On GitHub, choose your organization and request installation approval. Your GitHub admin reviews access there. Return here after they approve it.</p>}<Button onClick={refresh}>Check connection</Button>{github.error&&<><p role="alert"><VisibleText text={github.error}/></p><Button onClick={()=>host.signIn("/app/onboard")}>Sign in again</Button></>}</>;
}
