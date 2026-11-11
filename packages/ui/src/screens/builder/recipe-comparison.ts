import { ResolvedRecipeSchema } from "@agentx/cloud-contracts/web";
import type { AgentDiffResponseReaderSchema } from "@agentx/cloud-contracts/web";
export type ReadRecipeDiff = ReturnType<typeof AgentDiffResponseReaderSchema.parse>;
export interface RecipeChange { label:string; before:unknown; after:unknown; notes:string[] }
const labels:Record<string,string>={instructions:"Additional instructions",model:"Model",fallbackModel:"Fallback model",thinkingLevel:"Reasoning effort",timeoutMinutes:"Time limit (minutes)",tools:"Tools",autonomy:"Autonomy",approvals:"Approval rules",allowMentions:"Mentions",triggers:"Triggers",skills:"Skills",steps:"Recipe steps",sequence:"Step order",agentName:"Workflow",modelId:"Model",sourceId:"Source",provider:"Provider",alwaysAsk:"Always ask",maxRounds:"Maximum review rounds",backTo:"Return to",onFindings:"When review finds issues"};
export const fieldLabel=(name:string):string=>labels[name]??name.replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/^./,c=>c.toUpperCase());
function tokens(path:string):string[]{if(!path.startsWith("/")||/~(?![01])/u.test(path))throw new Error("Invalid comparison");const parts=path.slice(1).split("/").map(p=>p.replace(/~1/g,"/").replace(/~0/g,"~"));if(parts.some(p=>["__proto__","prototype","constructor"].includes(p)))throw new Error("Invalid comparison");return parts;}
function at(root:unknown,parts:string[]):unknown {let value=root;for(const part of parts){if(value===undefined||value===null)return undefined;if(typeof value!=="object"||!Object.hasOwn(value,part))return undefined;value=(value as Record<string,unknown>)[part];}return value;}
function record(value:unknown):Record<string,unknown>|undefined{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
function stepName(recipe:unknown,index:string){return record(at(recipe,["steps",index]))?.name;}
function baseVersions(recipe:unknown){const chain=at(recipe,["chain"]);return Array.isArray(chain)?chain.filter((layer,i)=>record(layer)?.builtin===true||i<chain.length-1).map(layer=>record(layer)?.version):undefined;}
export function comparisonRows(diff:ReadRecipeDiff):RecipeChange[]{
 const source=diff.comparison;if(!source)return [];
 const data={before:ResolvedRecipeSchema.parse(source.before),after:ResolvedRecipeSchema.parse(source.after)};
 const grouped=new Map<string,string[]>();
 for(const path of diff.changes){if(!path.startsWith("/"))continue;let parts=tokens(path);const instruction=parts.indexOf("instructions");if(instruction>=0)parts=parts.slice(0,instruction+1);const model=parts.findIndex(p=>p==="model"||p==="fallbackModel");if(model>=0)parts=parts.slice(0,model+1);grouped.set(JSON.stringify(parts),parts);}
 return [...grouped.values()].map(parts=>{
 const base=parts[0]==="base"&&parts[1]==="version",before=base?baseVersions(data.before):at(data.before,parts),after=base?baseVersions(data.after):at(data.after,parts);
 if(before===undefined&&after===undefined)throw new Error("Missing comparison values");
 const name=parts[0]==="steps"&&parts.length>1?(stepName(data.after,parts[1]!)??stepName(data.before,parts[1]!)):undefined;
 const removed=parts[0]==="steps"&&parts.length===2&&after===undefined,added=parts[0]==="steps"&&parts.length===2&&before===undefined;
 const displayName=typeof name==="string"?name:"Step";
 const label=removed?"Removed step: "+displayName:added?"Added step: "+displayName:base?"Base version":typeof name==="string"?name+" · "+(parts.length===2?"Step":fieldLabel(parts.at(-1)!)):parts.map(fieldLabel).join(" · ");
 const notes:string[]=[];
 if(parts.length===1&&parts[0]==="steps"&&Array.isArray(before)&&Array.isArray(after)){
  for(const step of before){const row=record(step);if(!after.some(item=>record(item)?.id===row?.id))notes.push("Removed step: "+(typeof row?.name==="string"?row.name:"Step"));}
  for(const step of after){const row=record(step);if(!before.some(item=>record(item)?.id===row?.id))notes.push("Added step: "+(typeof row?.name==="string"?row.name:"Step"));}
 }
 return {label,before,after,notes};
 });
}
