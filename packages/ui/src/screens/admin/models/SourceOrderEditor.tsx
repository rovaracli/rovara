import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../../host.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { VisibleText, visibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { sourceOrderSnapshot, sourceOrderReceipt, sameSourceOrder, type SourceOrderSnapshot } from "./source-order.js";
type Props = { available: boolean };
type Attempt = { requestId: string; snapshot: SourceOrderSnapshot; order: string[] };
async function bounded<T>(work: Promise<T>): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([work,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Source operation timed out.")),30_000);})]); }finally{clearTimeout(timer);}
}
export function SourceOrderEditor(props: Props) {
 const context=useAdminContext();return <OrderEditor key={`${context.orgId}:${context.developerId}:${context.role}`} {...props} />;
}
function OrderEditor({available}: Props) {
 const context=useAdminContext(),host=useAppHost(),query=useQueryClient(),api=useMemo(()=>createApiClient(host),[host]),unavailableId=useId();
 const schema=useMemo(()=>sourceOrderSnapshot(context.orgId,context.developerId),[context.orgId,context.developerId]);
 const [open,setOpen]=useState(false),[base,setBase]=useState<SourceOrderSnapshot>(),[draft,setDraft]=useState<string[]>([]),[attempt,setAttempt]=useState<Attempt>(),[busy,setBusy]=useState(false),[sent,setSent]=useState(false),[verified,setVerified]=useState(false),[message,setMessage]=useState<string>(),[checked,setChecked]=useState<SourceOrderSnapshot>();
 const [announcement,setAnnouncement]=useState<string>();
 const draftList=useRef<HTMLOListElement>(null),focusMove=useRef<{index:number;direction:-1|1}|undefined>(undefined);
 useLayoutEffect(()=>{const move=focusMove.current;if(move!==undefined){focusMove.current=undefined;const item=draftList.current?.children[move.index],preferred=item?.querySelector<HTMLButtonElement>(`button[data-move="${move.direction}"]:not(:disabled)`);(preferred??item?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus();}},[draft]);
 const alive=useRef(true),version=useRef(0),sending=useRef(false),submitted=useRef(false),ack=useRef<{order:string[];revision:number}|undefined>(undefined),notice=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(message&&!busy)notice.current?.focus();},[message,busy]);
 const valid=(ticket:number)=>alive.current&&version.current===ticket;
 const allowed=available&&!context.checking&&(context.role==="owner"||context.role==="admin");
 const changed=base!==undefined&&!sameSourceOrder(base.order,draft);
 function recheckIdentity(){void query.invalidateQueries({queryKey:["admin","identity"]});}
 async function identity(){
  const me=await api.get("/v1/app/me",AppMeResponseReaderSchema);
  if(me.org.orgId!==context.orgId||me.developer.id!==context.developerId||(me.developer.orgRole!=="owner"&&me.developer.orgRole!=="admin")){recheckIdentity();throw new Error("Company access changed.");}
 }
 async function fresh(){await identity();const snapshot=await api.get("/v1/app/org/model-sources",schema);await identity();return snapshot;}
 function stale(snapshot:SourceOrderSnapshot){setAnnouncement(undefined);setBase(snapshot);setDraft([...snapshot.order]);setAttempt(undefined);setMessage("Sources changed. Review the current order again.");}
 function refused(error:unknown){if(error instanceof ApiError&&([401,403].includes(error.status)||error.code==="INVALID_RESPONSE"))recheckIdentity();}
 async function load(ticket:number){try{const snapshot=await bounded(fresh());if(valid(ticket)){setBase(snapshot);setDraft([...snapshot.order]);}}catch(error){refused(error);if(valid(ticket))setMessage("Couldn't verify the current source order. Close and try again.");}finally{if(valid(ticket))setBusy(false);}}
 function changeOpen(value:boolean){
  if(sending.current&&submitted.current)return;if(value&&!allowed)return;
  const ticket=++version.current;setOpen(value);
  if(value){setAnnouncement(undefined);focusMove.current=undefined;setBase(undefined);setDraft([]);setAttempt(undefined);setMessage(undefined);setChecked(undefined);setVerified(false);setSent(false);submitted.current=false;ack.current=undefined;setBusy(true);void load(ticket);}
 }
 function move(index:number,delta:-1|1){if(busy||attempt||!allowed)return;const next=[...draft],other=index+delta;if(other<0||other>=next.length)return;[next[index],next[other]]=[next[other]!,next[index]!];focusMove.current={index:other,direction:delta};setDraft(next);setAnnouncement(`${visibleText(label(next[other]))} moved to position ${other+1} of ${next.length}.`);}
 async function review(){
  if(busy||!allowed||!base||!changed)return;const ticket=version.current;setBusy(true);setMessage(undefined);
  try{const snapshot=await bounded(fresh());if(!valid(ticket))return;if(snapshot.revision!==base.revision||!sameSourceOrder(snapshot.order,base.order)){stale(snapshot);return;}setBase(snapshot);setAttempt({requestId:crypto.randomUUID(),snapshot,order:[...draft]});}
  catch(error){refused(error);if(valid(ticket))setMessage("Couldn't verify the current source order. Try again.");}finally{if(valid(ticket))setBusy(false);}
 }
 async function check(ticket:number,current:Attempt){
  const snapshot=await bounded(fresh());if(!valid(ticket))return;
  const key=["admin","lane-c","sources",context.orgId,context.developerId,context.role];
  await query.cancelQueries({queryKey:key,exact:true});if(!valid(ticket))return;
  query.setQueryData(key,snapshot);setChecked(snapshot);
  if(ack.current&&snapshot.revision===ack.current.revision&&sameSourceOrder(snapshot.order,current.order)){setVerified(true);setMessage("Source order verified.");}
  else setMessage(ack.current?"Current source state differs from the response. Close and reload before another change.":"Current source order checked. The request outcome remains unconfirmed.");
 }
 async function confirm(){
  if(sending.current||busy||!allowed||!attempt||sent)return;const current=attempt,ticket=version.current;sending.current=true;setBusy(true);setMessage(undefined);
  try{
   const snapshot=await bounded(fresh());if(!valid(ticket))return;
   if(snapshot.revision!==current.snapshot.revision||!sameSourceOrder(snapshot.order,current.snapshot.order)){stale(snapshot);return;}
   submitted.current=true;setSent(true);
   const result=await bounded(api.send("PUT","/v1/app/org/model-sources-order",{requestId:current.requestId,expectedOrgId:current.snapshot.orgId,expectedDeveloperId:current.snapshot.developerId,expectedRevision:current.snapshot.revision,order:current.order},sourceOrderReceipt));
   if(!valid(ticket))return;
   if(result.kind!=="done"||result.value.revision!==current.snapshot.revision+1||!sameSourceOrder(result.value.order,current.order)){setMessage("The response could not be verified. Check the current order before another change.");return;}
   ack.current=result.value;await check(ticket,current);
  }catch(error){refused(error);if(valid(ticket))setMessage(error instanceof ApiError&&error.code==="CHANGE_STALE"?"Sources changed. Check the current order before another change.":submitted.current?"The outcome is unknown. Check the current order before making another change.":"Couldn't verify the current source order. Try again.");}
  finally{sending.current=false;if(valid(ticket))setBusy(false);}
 }
 async function manualCheck(){if(busy||!attempt)return;const ticket=version.current;setBusy(true);try{await check(ticket,attempt);}catch(error){refused(error);if(valid(ticket))setMessage("The current order could not be verified. Close and reload before another change.");}finally{if(valid(ticket))setBusy(false);}}
 const label=(id:string)=>id==="rovara"?"Rovara":id==="personal-chatgpt"?"Personal ChatGPT":base?.sources.find(s=>s.sourceId===id)?.label??"Unknown source";
 const list=(ids:readonly string[])=> <ol>{ids.map(id=><li key={id}><VisibleText text={label(id)} /></li>)}</ol>;
 return <><Dialog title="Change source order" description="Reorder the sources already in use. Cancel discards the proposal." open={open} onOpenChange={changeOpen} trigger={<Button disabled={!allowed} aria-describedby={!available?unavailableId:undefined}>Change source order</Button>}>
 <div aria-busy={busy}><p>Company: <VisibleText text={context.company} /></p><p>Costs can change. Price estimates are unavailable. This does not verify provider or model access.</p><p>Applies when a new route is resolved. Running tasks keep their resolved routes.</p>
 {!base&&busy&&<p role="status">Loading current source order...</p>}
 {base&&busy&&<p role="status">{sent?"Checking the source-order outcome...":"Checking current source order..."}</p>}
 {base&&<><h3>Order at review</h3>{list(base.order)}<h3>Proposed order</h3>{!attempt&&<p role="status" aria-live="polite" aria-atomic="true">{announcement}</p>}{attempt?list(attempt.order):<ol ref={draftList}>{draft.map((id,index)=><li key={id}><VisibleText text={label(id)} /> <Button disabled={busy||!allowed||index===0} data-move={-1} aria-label={`Move up, ${visibleText(label(id))}`} onClick={()=>move(index,-1)}>Move up</Button> <Button disabled={busy||!allowed||index===draft.length-1} data-move={1} aria-label={`Move down, ${visibleText(label(id))}`} onClick={()=>move(index,1)}>Move down</Button></li>)}</ol>}</>}
 {checked&&<><h3>Checked current order</h3>{list(checked.order)}</>}
 {context.checking&&<p role="status">Checking company access...</p>}
 {message&&<p ref={notice} tabIndex={-1} role={verified?"status":"alert"}>{message}</p>}
 {!sent&&(attempt?<Button disabled={busy||!allowed} onClick={()=>{void confirm();}}>Confirm source order</Button>:<Button disabled={busy||!allowed||!changed} onClick={()=>{void review();}}>Review order</Button>)}
 {sent&&!verified&&<Button disabled={busy} onClick={()=>{void manualCheck();}}>Check current order</Button>}
 <Button disabled={busy} onClick={()=>changeOpen(false)}>{sent?"Close":"Cancel"}</Button>
 </div></Dialog>{!available&&<p id={unavailableId}>Source-order editing is unavailable until a current company, sign-in and revision snapshot with at least two ordered sources is available.</p>}</>;
}
