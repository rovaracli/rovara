import {expect,it} from "vitest";
import {writeProjectModelSelection} from "../../packages/broker/src/model-selection/selection-write.js";
import {mergeWorld} from "../support/rovara-code-merge-world.js";
import {ORG_A,MAX,ARJUN} from "../support/agent-session-world.js";
import { projectRevisionKey, projectSelectionKey, STAGE_IDS } from "@rovara-code/contracts";
import {bedrockClaudeModelIds} from "../../packages/model-runtime/src/catalog.js";
function fixture(){
 const w=mergeWorld(),ids=bedrockClaudeModelIds("us"),models=ids.slice(0,2).map(modelId=>({provider:"amazon-bedrock",modelId}));
 const key=projectRevisionKey(ORG_A,"web",1),row=w.db.get(key)!;
 w.db.set({...row,definition:{...(row.definition as Record<string,unknown>),models:{default:models[0],approved:models}}});
 w.db.set({pk:`ORG#${ORG_A}#SETTINGS`,sk:"MODEL_SELECTION_POLICY",orgId:ORG_A,entityType:"MODEL_SELECTION_POLICY",version:1,revision:1,rankingVersion:"g3-v1",stepOverrides:Object.fromEntries(STAGE_IDS.map(stage=>[stage,{locked:true,thinkingLevel:null,model:models[stage==="plan_check"||stage==="code_review"||stage==="security_review"?1:0]}]))});
 return {w,model:models[1]!,input:{orgId:ORG_A,project:"web",signedInId:MAX,developerId:MAX,model:models[1]!,surface:"slack" as const,requestId:"selection-write-test"}};
}
it("commits a verified safe selection with native authority and the existing atomic audit",async()=>{
 const {w,model,input}=fixture();
 expect(await writeProjectModelSelection(w.deps,input)).toMatchObject({model});
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toMatchObject({model,entityType:"PROJECT_MODEL_SELECTION"});
 expect(w.audit.flushed().filter(event=>event.action==="project.model_selection_changed")).toHaveLength(1);
});
it("refuses a contributor before writing selection or audit",async()=>{
 const {w,input}=fixture();
 await expect(writeProjectModelSelection(w.deps,{...input,developerId:ARJUN,signedInId:ARJUN})).rejects.toThrow("FORBIDDEN");
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toBeUndefined();expect(w.audit.flushed()).toHaveLength(0);
});

for(const race of ["role","sources"] as const)it(`rolls back selection and audit on a ${race} change at commit`,async()=>{
 const {w,input}=fixture();const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 const { projectMemberKey, modelSourcesKey } = await import("@rovara-code/contracts");
 const deps={...w.deps,documentClient:{send:async(command:unknown)=>{
  if(command instanceof TransactWriteCommand){
   if(race==="role"){const key=projectMemberKey(ORG_A,MAX,"web");w.db.set({...w.db.get(key)!,role:"viewer",projectRole:"viewer"});}
   else w.db.set({...modelSourcesKey(ORG_A),revision:1});
  }
  return w.db.send(command as Parameters<typeof w.db.send>[0]);
 }}};
 await expect(writeProjectModelSelection(deps,input)).rejects.toThrow();
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toBeUndefined();
 expect(w.audit.pending()).toHaveLength(0);expect(w.audit.flushed()).toHaveLength(0);
});
it("does not emit another selection event for an identical retry",async()=>{
 const {w,input}=fixture();await writeProjectModelSelection(w.deps,input);await writeProjectModelSelection(w.deps,input);
 expect(w.audit.flushed().filter(event=>event.action==="project.model_selection_changed")).toHaveLength(1);
});

for(const role of ["owner","admin","maintainer","contributor","viewer"] as const)it(`shared selection writer enforces the live ${role} role`,async()=>{
 const {w,input}=fixture();const { orgMemberKey, developerOrgKey } = await import("@agentx/cloud-contracts"), { projectMemberKey } = await import("@rovara-code/contracts");
 const orgRole=role==="owner"||role==="admin"?role:"member";
 for(const key of [orgMemberKey(ORG_A,MAX),developerOrgKey(MAX)])w.db.set({...w.db.get(key)!,role:orgRole});
 const grantKey=projectMemberKey(ORG_A,MAX,"web");w.db.set({...w.db.get(grantKey)!,role:role==="viewer"?"viewer":"developer",projectRole:role==="owner"||role==="admin"?"contributor":role});
 const action=writeProjectModelSelection(w.deps,input),allowed=role==="owner"||role==="admin"||role==="maintainer";
 if(allowed)await action;else await expect(action).rejects.toThrow("FORBIDDEN");
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))!==undefined).toBe(allowed);
 expect(w.audit.flushed().length).toBe(allowed?1:0);
});
it("refuses a person who has become an Auditor, even with a maintainer grant, at the role step and again at the authority step (I2 re-check)",async()=>{
 const {w,input}=fixture();const { orgMemberKey, developerOrgKey } = await import("@agentx/cloud-contracts"), { projectMemberKey } = await import("@rovara-code/contracts");
 const {projectModelSelectionAuthorityChecks}=await import("../../packages/broker/src/model-selection/authority.js");
 for(const key of [orgMemberKey(ORG_A,MAX),developerOrgKey(MAX)])w.db.set({...w.db.get(key)!,role:"auditor"});
 const grantKey=projectMemberKey(ORG_A,MAX,"web");w.db.set({...w.db.get(grantKey)!,role:"developer",projectRole:"maintainer"});
 await expect(writeProjectModelSelection(w.deps,input)).rejects.toThrow("Your company access changed.");
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toBeUndefined();expect(w.audit.flushed()).toHaveLength(0);
 await expect(projectModelSelectionAuthorityChecks(w.deps,{orgId:ORG_A,project:"web",registeredAt:"2026-10-01T00:00:00.000Z",signedInId:MAX,developerId:MAX})).rejects.toThrow("Reload before changing model choices.");
});
it("refuses the same signed-in person in another company without a selection or audit",async()=>{
 const {w,input}=fixture();
 await expect(writeProjectModelSelection(w.deps,{...input,orgId:"org_bbbbbbbbbbbbbbbbbbbb"})).rejects.toThrow("FORBIDDEN");
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toBeUndefined();expect(w.audit.flushed()).toHaveLength(0);
});

it("refuses reusing a request id for a different verified selection",async()=>{
 const {w,input}=fixture();await writeProjectModelSelection(w.deps,input);
 const {bedrockClaudeModelIds}=await import("../../packages/model-runtime/src/catalog.js");
 const other={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 await expect(writeProjectModelSelection(w.deps,{...input,model:other})).rejects.toThrow("IDEMPOTENCY_CONFLICT");
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toMatchObject({model:input.model});
 expect(w.audit.flushed()).toHaveLength(1);
});
for(const timing of ["before","commit"] as const)it(`refuses global identity revocation ${timing} selection commit`,async()=>{
 const {w,input}=fixture();const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 const revoke=()=>{const row=w.db.get(`DEVELOPER#${MAX}`,"META")!;w.db.set({...row,revoked:true});};
 if(timing==="before")revoke();
 const deps={...w.deps,documentClient:{send:async(command:unknown)=>{if(timing==="commit"&&command instanceof TransactWriteCommand)revoke();return w.db.send(command as Parameters<typeof w.db.send>[0]);}}};
 await expect(writeProjectModelSelection(deps,input)).rejects.toThrow();
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toBeUndefined();expect(w.audit.pending()).toHaveLength(0);expect(w.audit.flushed()).toHaveLength(0);
});

it("replays the recorded outcome without overwriting a newer selection",async()=>{
 const {w,input}=fixture();const first=await writeProjectModelSelection(w.deps,input);
 const other={provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!};
 await writeProjectModelSelection(w.deps,{...input,requestId:"newer-selection",model:other});
 expect(await writeProjectModelSelection(w.deps,input)).toEqual(first);
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toMatchObject({model:other});
 expect(w.audit.flushed()).toHaveLength(2);
});
it("rechecks global identity before returning an existing request receipt",async()=>{
 const {w,input}=fixture();await writeProjectModelSelection(w.deps,input);
 const row=w.db.get(`DEVELOPER#${MAX}`,"META")!;w.db.set({...row,revoked:true});
 await expect(writeProjectModelSelection(w.deps,input)).rejects.toThrow("FORBIDDEN");
 expect(w.audit.flushed()).toHaveLength(1);
});

it("preserves the committed receipt and pending audit during an intake outage",async()=>{
 const {w,input}=fixture();w.audit.queueDown();
 const first=await writeProjectModelSelection(w.deps,input);
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toMatchObject({model:input.model});
 expect(w.audit.pending()).toHaveLength(1);expect(w.audit.flushed()).toHaveLength(0);
 expect(await writeProjectModelSelection(w.deps,input)).toEqual(first);
 expect(w.audit.pending()).toHaveLength(1);
});
it("refuses a receipt mutation between replay read and its authority transaction",async()=>{
 const {w,input}=fixture();await writeProjectModelSelection(w.deps,input);
 const { agentRequestKey } = await import("@rovara-code/contracts");
 const {TransactWriteCommand}=await import("@aws-sdk/lib-dynamodb");
 const deps={...w.deps,documentClient:{send:async(command:unknown)=>{
  if(command instanceof TransactWriteCommand){const key=agentRequestKey(ORG_A,MAX,input.requestId);w.db.set({...w.db.get(key)!,fingerprint:"changed"});}
  return w.db.send(command as Parameters<typeof w.db.send>[0]);
 }}};
 await expect(writeProjectModelSelection(deps,input)).rejects.toThrow();
 expect(w.db.get(projectSelectionKey(ORG_A,"web"))).toMatchObject({model:input.model});expect(w.audit.flushed()).toHaveLength(1);
});
it("refuses a malformed stored receipt without overwriting the selection",async()=>{
 const {w,input}=fixture();await writeProjectModelSelection(w.deps,input);
 const { agentRequestKey } = await import("@rovara-code/contracts");
 const key=agentRequestKey(ORG_A,MAX,input.requestId);w.db.set({...w.db.get(key)!,result:{model:input.model,approved:true}});
 await expect(writeProjectModelSelection(w.deps,input)).rejects.toThrow("could not be verified");
 expect(w.audit.flushed()).toHaveLength(1);
});
