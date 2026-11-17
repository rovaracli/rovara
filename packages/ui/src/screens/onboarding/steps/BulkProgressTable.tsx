import { Link } from "react-router";
import { Button } from "../../../design/Button.js";
import { DataTable, type Column } from "../../../design/DataTable.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { checklistHref, refusalWords, retryable } from "./repo-choice.js";
export type BulkRow = { repository: string; outcome: string; project?: string; reason?: string; [other: string]: unknown };
/**
 * The bulk progress table (guided onboarding PR 10): one row per repository, the project it made (or why it made none), its setup state and the next step.
 * Hosted Code has no setup-run route yet, so a created project says "Waiting for setup" and nothing here starts a run.
 */
export function BulkProgressTable({rows,busy,error,onRetry,onPickAgain,onSetUp}:{rows:readonly BulkRow[];busy:boolean;error?:string|undefined;onRetry:()=>void;onPickAgain:(repository:string)=>void;onSetUp:(project:string)=>void}){
 const made=(row:BulkRow)=>row.outcome==="created"&&typeof row.project==="string"?row.project:undefined,why=(row:BulkRow)=>typeof row.reason==="string"?row.reason:"";
 const created=rows.flatMap(row=>made(row)===undefined?[]:[made(row)!]),again=rows.some(row=>made(row)===undefined&&retryable(why(row)));
 const columns:Column<BulkRow>[]=[
  {key:"project",title:"Project",render:row=>made(row)!==undefined?<><strong><VisibleText text={made(row)!}/></strong> <span className="rv-muted">from <VisibleText text={row.repository}/></span></>:<><VisibleText text={row.repository}/> <span className="rv-muted">(not created)</span></>},
  {key:"setup",title:"Setup",render:row=>made(row)!==undefined?"Waiting for setup":<span role="status"><VisibleText text={refusalWords(why(row))}/></span>},
  {key:"next",title:"Next step",render:row=>made(row)!==undefined?<Link to={checklistHref(made(row)!)}>Open <VisibleText text={made(row)!}/></Link>:why(row)==="name_taken"?<Button onClick={()=>onPickAgain(row.repository)}>Create it on its own with another name</Button>:retryable(why(row))?"Try again below":"Check the GitHub connection, then choose it again"},
 ];
 return <section aria-label="Projects created" data-testid="bulk-progress"><h3>{created.length===rows.length?"Your projects are created":`${String(created.length)} of ${String(rows.length)} projects created`}</h3><DataTable caption="Projects from your repositories" columns={columns} rows={rows} rowKey={row=>row.repository}/><p>{created.length>0?"Setup hasn't started for these projects yet. Open one to set it up.":"Nothing was created."}</p>{created[0]!==undefined&&<Button variant="primary" onClick={()=>onSetUp(created[0]!)}>Set up the first project</Button>}{again&&<Button busy={busy} onClick={onRetry}>Try the rest again</Button>}{error&&<p role="alert"><VisibleText text={error}/></p>}</section>;
}
