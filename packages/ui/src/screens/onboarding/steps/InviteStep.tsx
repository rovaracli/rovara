import { useState } from "react";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { safeExternalUrl } from "../../../text/links.js";
export function InviteStep({onNext}:{onNext:()=>void}){
 const api=useOnboardingApi(),[email,setEmail]=useState(""),[link,setLink]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 async function invite(){setBusy(true);setError(undefined);setLink(undefined);try{const result=await api.invite({requestId:crypto.randomUUID(),role:"member",...(email?{email}:{})});const safe=safeExternalUrl(result.inviteUrl);if(!safe)throw new Error("Couldn't read the invitation link.");setLink(safe);}catch(e){setError(e instanceof Error?e.message:"Couldn't create an invite.");}finally{setBusy(false);}}
 return <><h2>Invite teammates</h2><p>Bring someone into the same workspace. Share this invite with them; no email is sent here.</p><form onSubmit={event=>{event.preventDefault();void invite();}}><TextField label="Teammate email (optional)" type="email" value={email} maxLength={254} onChange={event=>setEmail(event.target.value)}/><Button type="submit" busy={busy}>Create invite link</Button></form>{link&&<TextField label="Invite link" value={link} readOnly onFocus={event=>event.target.select()}/>}<Button variant="primary" onClick={onNext}>{link?"Continue":"Skip for now"}</Button>{error&&<p role="alert"><VisibleText text={error}/></p>}</>;
}
