import {expect,it} from "vitest";
import {TransactWriteCommand} from "@aws-sdk/lib-dynamodb";
import { projectPlaybookKey, projectSelectionKey } from "@rovara-code/contracts";
import {projectSelectionWriteCondition,projectSelectionPlaybookCheck,projectSelectionProcessCheck,projectSelectionAncestorChecks} from "../../packages/broker/src/model-selection/selection-inputs.js";
import {mergeWorld} from "../support/rovara-code-merge-world.js";
import {ORG_A} from "../support/agent-session-world.js";
const model={provider:"anthropic",modelId:"claude-sonnet-4"};
for(const existing of [false,true])for(const race of ["none","selection","playbook","process"] as const)it(`fences ${existing?"stored":"absent"} selection inputs against ${race} race`,async()=>{
 const w=mergeWorld(),selectionKey=projectSelectionKey(ORG_A,"web"),playbookKey=projectPlaybookKey(ORG_A,"web");
 const playbook={exists:existing,revision:existing?2:0,defaultProcess:{kind:"builtin" as const}};
 if(existing){w.db.set({...selectionKey,model});w.db.set({...playbookKey,revision:2,defaultProcess:{kind:"builtin"}});}
 const condition=projectSelectionWriteCondition(existing?{exists:true,model}:{exists:false});
 const check=projectSelectionPlaybookCheck("state",ORG_A,"web",playbook);
 if(race==="selection")w.db.set({...selectionKey,model:{provider:"anthropic",modelId:"claude-opus-4"}});
 if(race==="playbook")w.db.set({...playbookKey,revision:3,defaultProcess:{kind:"builtin"}});
 if(race==="process")w.db.set({...playbookKey,revision:playbook.revision,defaultProcess:{kind:"project_process",agentId:"agt_aaaaaaaaaaaaaaaaaaaa"}});
 const command=new TransactWriteCommand({TransactItems:[check,{Put:{TableName:"state",Item:{...selectionKey,model},...condition}},{Put:{TableName:"state",Item:{pk:"C53_SELECTION_INPUTS",sk:"META"}}}]});
 if(race==="none"){await w.db.send(command);expect(w.db.get("C53_SELECTION_INPUTS","META")).toBeDefined();}
 else {await expect(w.db.send(command)).rejects.toThrow();expect(w.db.get("C53_SELECTION_INPUTS","META")).toBeUndefined();}
});

it("fences the selected active process version and native project identity",async()=>{
 const { agentKey } = await import("@rovara-code/contracts");
 const id="agt_aaaaaaaaaaaaaaaaaaaa",process={agentId:id,version:2,digest:"a".repeat(64)};
 for(const race of ["none","version","archive","owner"] as const){
  const w=mergeWorld(),key=agentKey(ORG_A,id,"META");
  const row={...key,orgId:ORG_A,purpose:"process",status:"active",owner:{kind:"project",project:"web"},currentVersion:2};
  w.db.set(row);const check=projectSelectionProcessCheck("state",ORG_A,"web",process);
  if(race==="version")w.db.set({...row,currentVersion:3});
  if(race==="archive")w.db.set({...row,status:"archived"});
  if(race==="owner")w.db.set({...row,owner:{kind:"project",project:"other"}});
  const command=new TransactWriteCommand({TransactItems:[check,{Put:{TableName:"state",Item:{pk:"C53_PROCESS",sk:"META"}}}]});
  if(race==="none")await w.db.send(command);else await expect(w.db.send(command)).rejects.toThrow();
  expect(w.db.get("C53_PROCESS","META")!==undefined).toBe(race==="none");
 }
});
it("fences a built-in pin and refuses unpublished process input",async()=>{
 const { builtinSettingsKey, builtinDefaultPin } = await import("@rovara-code/contracts");
 const version=builtinDefaultPin("rovara-code");
 for(const race of [false,true]){
  const w=mergeWorld();const check=projectSelectionProcessCheck("state",ORG_A,"web",{agentId:"rovara-code",version,digest:"a".repeat(64)});
  if(race)w.db.set({...builtinSettingsKey(ORG_A,"rovara-code"),pinnedVersion:version+1});
  const command=new TransactWriteCommand({TransactItems:[check,{Put:{TableName:"state",Item:{pk:"C53_PIN",sk:"META"}}}]});
  if(race)await expect(w.db.send(command)).rejects.toThrow();else await w.db.send(command);
  expect(w.db.get("C53_PIN","META")!==undefined).toBe(!race);
 }
 expect(()=>projectSelectionProcessCheck("state",ORG_A,"web",{agentId:"rovara-code",draftRevision:1,digest:"a".repeat(64)})).toThrow();
});

it("requires an explicit stored pin when validation used a nondefault built-in version",async()=>{
 const { builtinSettingsKey, builtinDefaultPin } = await import("@rovara-code/contracts");
 const version=builtinDefaultPin("rovara-code")+1;
 for(const stored of [false,true]){
  const w=mergeWorld();
  if(stored)w.db.set({...builtinSettingsKey(ORG_A,"rovara-code"),pinnedVersion:version});
  const check=projectSelectionProcessCheck("state",ORG_A,"web",{agentId:"rovara-code",version,digest:"a".repeat(64)});
  const command=new TransactWriteCommand({TransactItems:[check,{Put:{TableName:"state",Item:{pk:"C53_NONDEFAULT_PIN",sk:"META"}}}]});
  if(stored)await w.db.send(command);else await expect(w.db.send(command)).rejects.toThrow();
  expect(w.db.get("C53_NONDEFAULT_PIN","META")!==undefined).toBe(stored);
 }
});

it("rejects an archived inherited layer without following its newer current version",async()=>{
 const { agentKey } = await import("@rovara-code/contracts");
 const parent="agt_bbbbbbbbbbbbbbbbbbbb",root="agt_aaaaaaaaaaaaaaaaaaaa";
 const chain=[{agentId:"rovara-code",name:"Code",version:1,builtin:true},{agentId:parent,name:"Base",version:2,builtin:false},{agentId:root,name:"Process",version:1,builtin:false}];
 for(const archived of [false,true]){
  const w=mergeWorld();
  w.db.set({...agentKey(ORG_A,parent,"META"),orgId:ORG_A,status:archived?"archived":"active",currentVersion:3});
  const checks=projectSelectionAncestorChecks("state",ORG_A,root,chain);
  expect(checks.map(item=>item.ConditionCheck?.Key)).toEqual([agentKey(ORG_A,parent,"META")]);
  const command=new TransactWriteCommand({TransactItems:[...checks,{Put:{TableName:"state",Item:{pk:"C53_ANCESTOR",sk:"META"}}}]});
  if(archived)await expect(w.db.send(command)).rejects.toThrow();else await w.db.send(command);
  expect(w.db.get("C53_ANCESTOR","META")!==undefined).toBe(!archived);
 }
});
