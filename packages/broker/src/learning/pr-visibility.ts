// PR corrections stay stored while capture is off; read surfaces cannot count suggestions that rely on them.
import { LearningSuggestionSchema, isTerminalSuggestionStatus, type LearningCorrection, type LearningSuggestion } from "@agentx/contracts";
import { readMembers } from "./settle.js";
import { readLearningPartition, type LearningDeps, type LearningScope } from "./store.js";
export function dependsOnPr(suggestion:Pick<LearningSuggestion,"correctionIds">,members:ReadonlyMap<string,LearningCorrection>):boolean {
 const sources=suggestion.correctionIds.flatMap(id=>{const c=members.get(id);return c?[c]:[];});
 if(!sources.some(c=>c.source==="pr_comment"))return false;
 const rest=sources.filter(c=>c.source!=="pr_comment"&&c.standing==="member");return rest.length<2||new Set(rest.map(c=>c.taskId)).size<2;
}
/** Subtract only proven PR-dependent suggestions from STATE. A cut read cannot safely expose a card while capture is off. */
export async function visibleOpenCount(deps:LearningDeps,scope:LearningScope,count:number):Promise<number> {
 const page=await readLearningPartition(deps,scope,{prefix:"SUGGESTION#",maxItems:1000,maxPages:2,pageSize:500});if(page.cursor!==undefined)return 0;
 const suggestions=page.items.flatMap(item=>{const p=LearningSuggestionSchema.safeParse(item);return p.success&&!isTerminalSuggestionStatus(p.data.status)?[p.data]:[];});
 if(!suggestions.length)return count;
 const members=new Map((await readMembers(deps,scope,suggestions.flatMap(s=>s.correctionIds))).map(entry=>[entry.c.id,entry.c]));
 return Math.max(0,count-suggestions.filter(s=>dependsOnPr(s,members)).length);
}
