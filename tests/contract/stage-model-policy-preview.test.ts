import {expect,it} from "vitest";
import {QueryCommand} from "@aws-sdk/lib-dynamodb";
import {previewCompanyModelPolicy} from "../../packages/broker/src/model-selection/policy-preview.js";
import {FakeDynamoDb} from "../support/fake-dynamodb.js";
import {orgMemberKey,developerOrgKey,orgMetaKey,orgProjectCatalogKey,projectRevisionKey,STAGE_IDS} from "../../packages/contracts/src/index.js";
import type {StageModelSnapshot} from "../../packages/broker/src/model-selection/read.js";
const org="org_aaaaaaaaaaaaaaaaaaaa",person="a".repeat(64),model={provider:"anthropic",modelId:"claude-sonnet-4"},other={provider:"anthropic",modelId:"claude-opus-4"};
function fixture(role="owner",count=1){
 const db=new FakeDynamoDb(),caller={orgId:org,developerId:person};
 db.set({...orgMemberKey(org,person),orgId:org,developerId:person,role});db.set({...developerOrgKey(person),orgId:org,role});db.set({...orgMetaKey(org),orgId:org});
 for(let n=0;n<count;n++){const name=`web${n}`;db.set({...orgProjectCatalogKey(org,name),entityType:"PROJECT_CATALOG",orgId:org,name});}
 const snapshots:string[]=[];
 const deps={documentClient:db,tableName:"state",cursorKey:"preview-test-key",now:()=>0,loadSnapshot:async(_caller:typeof caller,project:string,policy?:{stepOverrides:Record<string,unknown>}):Promise<StageModelSnapshot>=>{
  snapshots.push(project);return {orgId:org,project,companyRevision:0,projectRevision:1,registeredAt:"2026-10-01T00:00:00Z",process:{agentId:"rovara-code",version:1,digest:"a".repeat(64)},canEdit:true,stages:STAGE_IDS.map(stage=>({orgId:org,stage,sourcesRevision:0,forbidden:[],builtinDefault:model,companyDefault:policy?.stepOverrides.build&&stage==="build"?{model:other}:undefined,candidates:[model,other].map(model=>({model,sourceId:"rovara",enabled:true,inEffectiveOrder:true,evidence:{orgId:org,sourcesRevision:0,kind:"rovara_catalog" as const}}))}))};
 }};return {db,caller,deps,snapshots};
}
for(const role of ["owner","admin","member","maintainer","viewer"])it(`uses live ${role} authority for preview`,async()=>{
 const f=fixture(role),action=previewCompanyModelPolicy(f.deps,f.caller,{version:1,expectedRevision:0,stepOverrides:{}});
 if(role==="owner"||role==="admin")expect(await action).toMatchObject({mayBeIncomplete:true,projects:[{project:"web0",impact:"unchanged"}]});else{await expect(action).rejects.toThrow("FORBIDDEN");expect(f.snapshots).toEqual([]);}
});
it("reads at most five catalog projects per page and binds cursors to actor and proposal",async()=>{
 const f=fixture("owner",7),queries:QueryCommand[]=[];const send=f.db.send.bind(f.db);f.db.send=async c=>{if(c instanceof QueryCommand)queries.push(c);return send(c);};
 const body={version:1 as const,expectedRevision:0,stepOverrides:{build:{model:other}}};const first=await previewCompanyModelPolicy(f.deps,f.caller,body);
 expect(first.projects).toHaveLength(5);expect(first.projects.every(row=>row.impact==="changed")).toBe(true);expect(first.nextCursor).toEqual(expect.any(String));expect(queries).toHaveLength(1);expect(queries[0]!.input.Limit).toBe(5);
 const next=await previewCompanyModelPolicy(f.deps,f.caller,{...body,cursor:first.nextCursor});expect(next.projects).toHaveLength(2);
 await expect(previewCompanyModelPolicy(f.deps,f.caller,{...body,stepOverrides:{},cursor:first.nextCursor})).rejects.toThrow("CONFIG_INVALID");
 expect(first).not.toHaveProperty("total");expect(first).not.toHaveProperty("counts");
});
it("sanitizes project read errors as partial unavailable rows and refuses stale policy or revoked authority",async()=>{
 const f=fixture();f.deps.loadSnapshot=async()=>{throw Error("private provider failure");};
 expect(await previewCompanyModelPolicy(f.deps,f.caller,{version:1,expectedRevision:0,stepOverrides:{}})).toMatchObject({projects:[{project:"web0",impact:"unavailable",reasonCodes:[]}]});
 await expect(previewCompanyModelPolicy(f.deps,f.caller,{version:1,expectedRevision:1,stepOverrides:{}})).rejects.toThrow("CHANGE_STALE");
 f.db.set({...developerOrgKey(person),orgId:"org_bbbbbbbbbbbbbbbbbbbb",role:"owner"});await expect(previewCompanyModelPolicy(f.deps,f.caller,{version:1,expectedRevision:0,stepOverrides:{}})).rejects.toThrow("FORBIDDEN");
});

it("rejects actor-replayed cursors and live role withdrawal after bounded reads",async()=>{
 const f=fixture("owner",6),body={version:1 as const,expectedRevision:0,stepOverrides:{}};
 const page=await previewCompanyModelPolicy(f.deps,f.caller,body),nextPerson="b".repeat(64);
 f.db.set({...orgMemberKey(org,nextPerson),orgId:org,developerId:nextPerson,role:"owner"});f.db.set({...developerOrgKey(nextPerson),orgId:org,role:"owner"});
 await expect(previewCompanyModelPolicy(f.deps,{orgId:org,developerId:nextPerson},{...body,cursor:page.nextCursor})).rejects.toThrow("CONFIG_INVALID");
 const original=f.deps.loadSnapshot;f.deps.loadSnapshot=async(...args)=>{const snapshot=await original(...args);f.db.set({...orgMemberKey(org,person),orgId:org,developerId:person,role:"member"});return snapshot;};
 await expect(previewCompanyModelPolicy(f.deps,f.caller,body)).rejects.toThrow("FORBIDDEN");
});
it("exposes only strict read-only preview bodies on the actual app router",async()=>{
 const {routeDeveloperRequest}=await import("../../packages/broker/src/aws/developer-routes.js"),f=fixture("owner",1);
 f.db.set({...projectRevisionKey(org,"web0",1),entityType:"PROJECT",registeredAt:"2026-10-01T00:00:00Z",definition:{name:"web0",revision:1,repositories:[{name:"web0",url:"https://github.com/acme/web.git",path:"repo/web",defaultBranch:"main",credentialRef:"github-app"}],setup:[],readiness:[],orchestratorInstructions:"Delegate work."}});
 const deps={documentClient:f.db,tableName:"state",now:()=>0,agentSessions:{documentClient:f.db,tableName:"state",now:()=>0,cursorKey:"preview-test-key",projectMembers:{roleOf:async()=>undefined},signInStore:{getDeveloper:async()=>undefined}},developer:{issuer:"https://cell.example/v1/auth",env:"test",signInTableName:"signin",methods:{cloud:true,slack:false,oidc:false},verifyAccessToken:async()=>({}),channelMembers:async()=>({ok:true as const,memberOf:[]})}};
 const caller={...f.caller,orgRole:"owner" as const,name:"A",amr:"cloud" as const,sessionId:"fixture"},path="/v1/app/org/model-selection-policy/preview",before=structuredClone([...f.db.items]);
 const invoke=(body:unknown)=>routeDeveloperRequest(deps,{method:"POST",path,headers:{},requestId:"preview",body:JSON.stringify(body)},new URL(path,"https://cell.example"),{caller,csrf:""});
 expect(await invoke({version:1,expectedRevision:0,stepOverrides:{}})).toMatchObject({mayBeIncomplete:true,projects:[{project:"web0",impact:"unchanged"}]});
 const {bedrockClaudeModelIds}=await import("../../packages/model-runtime/src/catalog.js");
 expect(await invoke({version:1,expectedRevision:0,stepOverrides:{build:{model:{provider:"amazon-bedrock",modelId:bedrockClaudeModelIds("us")[0]!}}}})).toMatchObject({projects:[{project:"web0",impact:"changed"}]});
 await expect(invoke({version:1,expectedRevision:0,stepOverrides:{},orgId:"foreign"})).rejects.toThrow("CONFIG_INVALID");
 expect([...f.db.items]).toEqual(before);
});

for(const changed of ["selection","playbook"] as const)it(`marks ${changed} races between comparison snapshots unavailable`,async()=>{
 const f=fixture(),original=f.deps.loadSnapshot;let call=0;
 f.deps.loadSnapshot=async(...args)=>{const snapshot=await original(...args);call++;if(changed==="selection")snapshot.selectionSnapshot=call===1?{exists:false}:{exists:true,model:other};else snapshot.playbookSnapshot={exists:true,revision:call,defaultProcess:{kind:"builtin"}};return snapshot;};
 expect(await previewCompanyModelPolicy(f.deps,f.caller,{version:1,expectedRevision:0,stepOverrides:{}})).toMatchObject({projects:[{project:"web0",impact:"unavailable"}]});
});
it("rejects a cursor whose scope was rewritten to another authorized person",async()=>{
 const f=fixture("owner",6),body={version:1 as const,expectedRevision:0,stepOverrides:{}},nextPerson="b".repeat(64);
 f.db.set({...orgMemberKey(org,nextPerson),orgId:org,developerId:nextPerson,role:"owner"});f.db.set({...developerOrgKey(nextPerson),orgId:org,role:"owner"});
 const page=await previewCompanyModelPolicy(f.deps,f.caller,body),cursor=page.nextCursor!;let forged:string;
 try{const decoded=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")) as Record<string,unknown>;decoded.developerId=nextPerson;forged=Buffer.from(JSON.stringify(decoded)).toString("base64url");}catch{forged=cursor.slice(0,-3)+(cursor.endsWith("AAA")?"BBB":"AAA");}
 await expect(previewCompanyModelPolicy(f.deps,{orgId:org,developerId:nextPerson},{...body,cursor:forged})).rejects.toThrow("CONFIG_INVALID");
});
