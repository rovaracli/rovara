import { useQuery } from "@tanstack/react-query";
import { useAgentApi } from "../../api/agents.js";
import { ApiError } from "../../api/errors.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "../agents/agent-context.js";
import { comparisonRows,fieldLabel } from "./recipe-comparison.js";
export type DiffFrom=number|"base"|"draft";export type DiffTo=number|"draft";
const unavailable="The before-and-after comparison is unavailable. Refresh before publishing.";
export function useRecipeDiff(id:string,from:DiffFrom,to:DiffTo,enabled=true,revision?:number){const api=useAgentApi();return useQuery({queryKey:["agent",id,"diff",from,to,...(revision===undefined?[]:[revision])],enabled,queryFn:async()=>{
 const diff=await api.diff(id,from,to);
 try{if(diff.from!==from||diff.to!==to)throw new Error("Wrong comparison");if(diff.changes.some(path=>path.startsWith("/"))&&!diff.comparison)throw new Error("Missing comparison");comparisonRows(diff);}catch{throw new ApiError(409,"COMPARISON_UNAVAILABLE",unavailable);}
 return diff;
}});}
function isInstructionLayer(value:unknown):value is {agentName:string;text:string}{
 if(value===null||typeof value!=="object")return false;
 const layer=value as Record<string,unknown>;return typeof layer.agentName==="string"&&typeof layer.text==="string";
}
function Value({value}:{value:unknown}){
 if(value===undefined)return <p className="rv-muted">Not set</p>;
 if(value===null)return <p className="rv-muted">Cleared</p>;
 if(typeof value==="boolean")return <p>{value?"Enabled":"Disabled"}</p>;
 if(typeof value==="string"||typeof value==="number")return <p className="rv-recipe-value"><VisibleText text={value===""?"Empty text":String(value)}/></p>;
 if(typeof value!=="object")return <p>Value unavailable</p>;
 if(Array.isArray(value))return value.length?<div>{(value as unknown[]).map((item,index)=>isInstructionLayer(item)?<div className="rv-recipe-layer" key={index}><p className="rv-muted">From <VisibleText text={item.agentName}/></p><p className="rv-recipe-value"><VisibleText text={item.text}/></p></div>:<Value key={index} value={item}/>)}</div>:<p className="rv-muted">None</p>;
 return <dl className="rv-recipe-fields">{Object.entries(value as Record<string,unknown>).map(([key,item])=><div key={key}><dt><VisibleText text={fieldLabel(key)}/></dt><dd><Value value={item}/></dd></div>)}</dl>;
}
const versionLabel=(value:DiffFrom|DiffTo)=>typeof value==="number"?"Version "+value:value==="draft"?"Draft":"Base recipe";
export function RecipeDiffView({id,from,to,revision}:{id:string;from:DiffFrom;to:DiffTo;revision?:number}){
 const read=useRecipeDiff(id,from,to,true,revision);
 if(read.isPending)return <Skeleton label="Loading recipe changes"/>;
 if(read.isError)return <p role="alert"><VisibleText text={failureText(read.error,"Couldn't read these recipe changes.")}/></p>;
 const rows=comparisonRows(read.data),descriptions=read.data.changes.filter(change=>!change.startsWith("/"));
 return <section aria-label="Recipe changes"><h3>What will change</h3>{rows.map((row,index)=><section className="rv-recipe-change" key={index} aria-label={row.label}><h4><VisibleText text={row.label}/></h4>{row.notes.map(note=><p key={note}><VisibleText text={note}/></p>)}<div className="rv-recipe-comparison"><div><h5>Before · {versionLabel(from)}</h5><Value value={row.before}/></div><div><h5>After · {versionLabel(to)}</h5><Value value={row.after}/></div></div></section>)}{descriptions.length>0&&<ul>{descriptions.map((change,index)=><li key={index}><VisibleText text={change}/></li>)}</ul>}{!read.data.changes.length&&<p>No recipe changes.</p>}</section>;
}
