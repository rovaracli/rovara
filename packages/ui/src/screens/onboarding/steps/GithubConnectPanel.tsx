import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { createApiClient } from "../../../api/client.js";
import { useAppHost } from "../../../host.js";
import { isGithubInstallationUrl } from "../../../text/links.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { GithubLink, githubLinkOutcome, GITHUB_LINK_MESSAGES } from "../../../shell/GithubLink.js";
// RULING Q54: preserve linked-identity requirements. UX1: the step detects a missing GitHub link and offers "Link your GitHub account" in place (any sign-in
// method; GitHub proves the account and the server links it to THIS account only), instead of sending the person to sign in again or to a terminal.
// UX3: the GitHub connect flow as one panel, used by the onboarding step and by the Connections page, so GitHub is set up in one way and one code path.
// `returnTo` is where GitHub's account-link step brings the person back to; `title` is shown only where the panel stands alone (the onboarding step).
export function GithubConnectPanel({requested,refresh,returnTo,title}:{requested:boolean;refresh:()=>void;returnTo:"/app/onboard"|"/app/admin/connections";title?:string}){
 const api=useOnboardingApi(),host=useAppHost(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[help,setHelp]=useState(false);
 const me=useQuery({queryKey:["me"],queryFn:()=>createApiClient(host).get("/v1/app/me",AppMeResponseReaderSchema)});
 const linked=me.data?.identities.some(identity=>identity.provider==="github")===true,outcome=githubLinkOutcome(host.currentPath());
 async function connect(){setBusy(true);setError(undefined);try{const result=await api.connect(returnTo);if(!isGithubInstallationUrl(result.installUrl))throw new Error("Rovara returned an invalid GitHub installation link.");host.navigate(result.installUrl);}catch(e){setError(e instanceof Error?e.message:"Couldn't connect GitHub.");setBusy(false);}}
 const heading=title===undefined?null:<h2>{title}</h2>;
 if(me.isSuccess&&!linked)return <>{heading}<p>First, link your GitHub account to your Rovara account. Rovara uses it to confirm you can install its GitHub App. Then you choose the repositories.</p>{me.data.linkable?.github===false?<p role="alert">GitHub sign-in isn't turned on for this Rovara install, so a GitHub account can't be linked yet. Ask Rovara support to turn it on.</p>:<GithubLink outcome={outcome} returnTo={returnTo} primary/>}</>;
 return <>{heading}<p>Choose the repositories this workspace can work on. GitHub will ask you to review access before you connect.</p>{outcome==="linked"&&<p role="status">Your GitHub account is linked. Now connect GitHub.</p>}{outcome!==undefined&&outcome!=="linked"&&<p role="status">{GITHUB_LINK_MESSAGES[outcome]}</p>}{requested&&<p role="status">We'll tell you when your GitHub admin approves it.</p>}<Button variant="primary" busy={busy} onClick={()=>{void connect();}}>Connect GitHub</Button><Button onClick={()=>setHelp(!help)}>Ask my GitHub admin</Button>{help&&<p>On GitHub, choose your organization and request installation approval. Your GitHub admin reviews access there. Return here after they approve it.</p>}<Button onClick={refresh}>Check connection</Button>{error&&<p role="alert"><VisibleText text={error}/></p>}</>;
}
