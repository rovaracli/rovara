import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useOnboardingApi } from "../../../api/onboarding.js";
import { Button } from "../../../design/Button.js";
import { TextField } from "../../../design/TextField.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { BulkProgressTable, type BulkRow } from "./BulkProgressTable.js";
import { PICK_MAX, SEPARATE_ABOVE, answeredTogether, retryable, type Together } from "./repo-choice.js";
const PAGE=50;
/** Why a read or a create failed, in the words Cloud gave (fixed sentences), or ours. */
const wordsOf=(error:unknown,fallback:string)=>error instanceof Error&&error.message?error.message:fallback;
/**
 * The repository picker (guided onboarding PR 10; design section 2): a multi-select, searchable, paged list of the company's repositories with "In project X"
 * marks. With more than one ticked it asks "Do these repos work together?": one project (preselected, one name) or separate projects (one per repo, named after
 * it; preselected above 8). The browser names no company: the list and the create are the signed-in person's, answered by Code.
 */
export function RepositoryPicker({onCreated}:{onCreated:(name:string)=>void}){
 const api=useOnboardingApi(),[search,setSearch]=useState(""),[q,setQ]=useState(""),[selected,setSelected]=useState<string[]>([]),[answer,setAnswer]=useState<Together>(),[name,setName]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[rows,setRows]=useState<BulkRow[]>(),[intent,setIntent]=useState(()=>crypto.randomUUID());
 useEffect(()=>{const timer=setTimeout(()=>setQ(search.trim()),250);return()=>clearTimeout(timer);},[search]);
 const choices=useInfiniteQuery({queryKey:["onboard","repository-choices",q],initialPageParam:undefined as string|undefined,queryFn:({pageParam})=>api.repositoryChoices({limit:PAGE,...(q?{q}:{}),...(pageParam?{after:pageParam}:{})}),getNextPageParam:page=>page.next,retry:false});
 const listed=useMemo(()=>choices.data?.pages.flatMap(page=>page.repositories)??[],[choices.data]),incomplete=choices.data?.pages.some(page=>page.incomplete)??false;
 const count=selected.length,together=answeredTogether(answer,count),changed=()=>setIntent(crypto.randomUUID());
 function toggle(fullName:string,on:boolean){setSelected(list=>on?(list.includes(fullName)||list.length>=PICK_MAX?list:[...list,fullName]):list.filter(entry=>entry!==fullName));changed();}
 async function run(repositories:string[],separate:boolean,requestId:string){setBusy(true);setError(undefined);try{if(separate){const result=await api.createSeparate({requestId,repositories});setRows(previous=>mergeRows(previous,result.results));setIntent(crypto.randomUUID());}else{const result=await api.createOne({requestId,repositories,...(name?{name}:{})});onCreated(result.project.definition.name);}}catch(e){setError(wordsOf(e,"Couldn't create the projects."));}finally{setBusy(false);}}
 const create=()=>run(selected,count>1&&together==="separate",intent);
 const label=count<=1?"Create 1 project":together==="separate"?`Create ${String(count)} projects`:`Create project with ${String(count)} repos`;
 if(rows!==undefined)return <BulkProgressTable rows={rows} busy={busy} onSetUp={onCreated} onPickAgain={repository=>{setRows(undefined);setSelected([repository]);setAnswer("one");setName("");setError(undefined);changed();}} onRetry={()=>{const again=rows.filter(row=>row.outcome!=="created"&&retryable(String(row.reason))).map(row=>row.repository);void run(again,true,crypto.randomUUID());}}/>;
 return <form onSubmit={event=>{event.preventDefault();void create();}}>
  <TextField label="Search repositories" type="search" value={search} onChange={event=>setSearch(event.target.value)} maxLength={100} hint="Part of a name, such as billing or acme/web."/>
  {choices.isPending?<p role="status">Loading repositories</p>:choices.isError?<><p role="alert"><VisibleText text={wordsOf(choices.error,"Couldn't load repositories.")}/></p><Button onClick={()=>{void choices.refetch();}}>Try again</Button></>:listed.length===0?<p role="status">{q?"No repositories match that search.":"No repositories yet. Add repositories to your GitHub connection, then check again."}</p>:<fieldset data-testid="repository-list"><legend>Repositories</legend>{listed.map(item=><label className="rv-onboarding-choice" key={item.githubRepositoryId}><input type="checkbox" value={item.fullName} checked={selected.includes(item.fullName)} disabled={!selected.includes(item.fullName)&&count>=PICK_MAX} onChange={event=>toggle(item.fullName,event.target.checked)}/><VisibleText text={item.fullName}/>{item.private&&<>{" "}<span className="rv-muted">private</span></>}{item.projects.length>0&&<>{" "}<span className="rv-onboarding-mark">In project <VisibleText text={item.projects.join(", ")}/></span></>}</label>)}</fieldset>}
  {choices.hasNextPage&&<Button busy={choices.isFetchingNextPage} onClick={()=>{void choices.fetchNextPage();}}>Show more repositories</Button>}
  {incomplete&&<p className="rv-muted">GitHub lists only the first 100 repositories of an account. Search by name to find the others.</p>}
  <p role="status" data-testid="picked-count">{count===0?"No repositories picked yet.":`${String(count)} ${count===1?"repository":"repositories"} picked${count>=PICK_MAX?" (the most one step takes)":""}.`}</p>
  {count>1&&<fieldset data-testid="together"><legend>Do these repos work together?</legend>
   <label className="rv-onboarding-choice"><input type="radio" name="together" value="one" checked={together==="one"} onChange={()=>{setAnswer("one");changed();}}/><span><strong>Yes, one project.</strong> Rovara can change them together in one task.</span></label>
   <label className="rv-onboarding-choice"><input type="radio" name="together" value="separate" checked={together==="separate"} onChange={()=>{setAnswer("separate");changed();}}/><span><strong>No, separate projects.</strong> One project per repo, each named after its repo.</span></label>
   {count>SEPARATE_ABOVE&&<p role="note" data-testid="why-separate">You picked more than {String(SEPARATE_ABOVE)} repos, so separate projects is preselected. One setup run has to make every repo build, so one broken repo would block the whole project.</p>}
  </fieldset>}
  {count>=1&&(count===1||together==="one")&&<TextField label="Project name (optional)" value={name} hint={count>1?"Lowercase letters, numbers and hyphens. Leave blank to name it after the first repo you picked.":"Lowercase letters, numbers and hyphens. Leave blank to use the repository name."} pattern="[a-z][a-z0-9-]{0,62}" maxLength={63} onChange={event=>{setName(event.target.value);changed();}}/>}
  <Button type="submit" variant="primary" busy={busy} disabled={count===0}>{label}</Button>
  {error&&<p role="alert"><VisibleText text={error}/></p>}
 </form>;
}
/** A retry's rows replace the earlier rows of the same repositories, in the order first asked. */
function mergeRows(previous:BulkRow[]|undefined,next:readonly BulkRow[]):BulkRow[]{
 if(previous===undefined)return [...next];
 const byRepository=new Map(next.map(row=>[row.repository,row] as const));
 return previous.map(row=>byRepository.get(row.repository)??row);
}
