import { useQuery } from "@tanstack/react-query";
import { useAgentApi } from "../../api/agents.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { failureText } from "../agents/agent-context.js";
export type DiffFrom=number|"base"|"draft";export type DiffTo=number|"draft";
export function useRecipeDiff(id:string,from:DiffFrom,to:DiffTo,enabled=true){const api=useAgentApi();return useQuery({queryKey:["agent",id,"diff",from,to],enabled,queryFn:()=>api.diff(id,from,to)});}
export function RecipeDiffView({id,from,to}:{id:string;from:DiffFrom;to:DiffTo}){const read=useRecipeDiff(id,from,to);return read.isPending?<Skeleton label="Loading recipe changes"/>:read.isError?<p role="alert"><VisibleText text={failureText(read.error,"Couldn't read these recipe changes.")}/></p>:<section aria-label="Recipe changes"><h3>What will change</h3>{read.data.changes.length?<ul>{read.data.changes.map((change,index)=><li key={index}><VisibleText text={change}/></li>)}</ul>:<p>No recipe changes.</p>}</section>;}
