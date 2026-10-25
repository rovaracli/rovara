import { useState } from "react";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { useAppHost } from "../../../host.js";
import { isGithubInstallationUrl } from "../../../text/links.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
// RULING Q54: preserve linked-identity requirements; deliberate sign-in recovery never links accounts in this screen.
export function ConnectGithubStep({requested,refresh}:{requested:boolean;refresh:()=>void}){
 const api=useOnboardingApi(),host=useAppHost(),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[help,setHelp]=useState(false);
 async function connect(){setBusy(true);setError(undefined);try{const result=await api.connect();if(!isGithubInstallationUrl(result.installUrl))throw new Error("Rovara returned an invalid GitHub installation link.");host.navigate(result.installUrl);}catch(e){setError(e instanceof Error?e.message:"Couldn't connect GitHub.");setBusy(false);}}
 return <><h2>Connect GitHub</h2><p>Choose the repositories this workspace can work on. GitHub will ask you to review access before you connect.</p>{requested&&<p role="status">We'll tell you when your GitHub admin approves it.</p>}<Button variant="primary" busy={busy} onClick={()=>{void connect();}}>Connect GitHub</Button><Button onClick={()=>setHelp(!help)}>Ask my GitHub admin</Button>{help&&<p>On GitHub, choose your organization and request installation approval. Your GitHub admin reviews access there. Return here after they approve it.</p>}<Button onClick={refresh}>Check connection</Button>{error&&<><p role="alert"><VisibleText text={error}/></p><Button onClick={()=>host.signIn("/app/onboard")}>Sign in again</Button></>}</>;
}
