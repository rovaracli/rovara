import { expect,it } from "vitest";
import { AUDIT_ACTIONS,AuditEventInputSchema } from "../../packages/contracts/src/audit.js";
import * as events from "../../packages/broker/src/audit/events.js";
const base={orgId:"org_aaaaaaaaaaaaaaaaaaaa",actor:{kind:"member" as const,id:"a".repeat(64)},occurredAt:"2026-10-27T16:00:00.000Z",occurrence:"revision-2",projectName:"project_1",definitionRevision:2};
const modelsFacts={beforeModelIdsDigest:"a".repeat(64),afterModelIdsDigest:"b".repeat(64),beforeDefaultModelIdDigest:"c".repeat(64),afterDefaultModelIdDigest:"d".repeat(64),beforeCount:1,afterCount:2,definitionRevision:2};
const selectionFacts={beforeModelIdDigest:"a".repeat(64),afterModelIdDigest:"b".repeat(64),sourceSurface:"slack",definitionRevision:2};
function event(action:string,facts:unknown){return {eventId:"aev_"+"a".repeat(40),orgId:base.orgId,actor:base.actor,occurredAt:base.occurredAt,action,target:{kind:"project",name:base.projectName},facts};}
function assertRegistered(action:string,facts:unknown){expect(AUDIT_ACTIONS as readonly string[]).toContain(action);expect(AuditEventInputSchema.safeParse(event(action,facts)).success).toBe(true);}
for(const [action,facts] of [["project.models_changed",modelsFacts],["project.model_selection_changed",selectionFacts]] as const){
 it(`registers ${action} with the existing scalar verifier shape`,()=>{expect(AUDIT_ACTIONS as readonly string[]).toContain(action);expect(AuditEventInputSchema.safeParse(event(action,facts)).success).toBe(true);});
 for(const field of ["rawModelIds","providerError","taskText"])it(`refuses ${field} facts on ${action}`,()=>{assertRegistered(action,facts);expect(AuditEventInputSchema.safeParse(event(action,{...facts,[field]:"unneeded-private-text"})).success).toBe(false);});
 it(`requires safe bounded facts and a project target for ${action}`,()=>{
  assertRegistered(action,facts);expect(AuditEventInputSchema.safeParse(event(action,undefined)).success).toBe(false);expect(AuditEventInputSchema.safeParse({...event(action,facts),target:{kind:"org",id:base.orgId}}).success).toBe(false);expect(AuditEventInputSchema.safeParse({...event(action,facts),details:[{subject:"org",fields:{task:"private task"}}]}).success).toBe(false);
 });
}
it("rejects malformed model commitments, counts, revisions and source surfaces",()=>{
 assertRegistered("project.models_changed",modelsFacts);assertRegistered("project.model_selection_changed",selectionFacts);
 for(const facts of [{...modelsFacts,afterModelIdsDigest:"not-a-digest"},{...modelsFacts,afterCount:17},{...modelsFacts,definitionRevision:-1}])expect(AuditEventInputSchema.safeParse(event("project.models_changed",facts)).success).toBe(false);
 for(const facts of [{...selectionFacts,afterModelIdDigest:"raw provider/model"},{...selectionFacts,sourceSurface:"arbitrary source"},{...selectionFacts,definitionRevision:1.5}])expect(AuditEventInputSchema.safeParse(event("project.model_selection_changed",facts)).success).toBe(false);
});
it("builds org/project/revision-bound events without copying free text or extra fields",()=>{
 expect(events).toHaveProperty("auditProjectModelsDigestChanged");expect(events).toHaveProperty("auditProjectModelSelectionDigestChanged");
 const extra={details:[{subject:"org",fields:{task:"unneeded-private-text"}}],rawModelIds:"unneeded-private-text"};
 const make=events.auditProjectModelsDigestChanged,input={...base,...modelsFacts,...extra};const first=make(input);
 expect(AuditEventInputSchema.safeParse(first).success).toBe(true);expect(first.facts).toEqual(modelsFacts);expect(first.target).toEqual({kind:"project",name:base.projectName});expect(JSON.stringify(first)).not.toContain("unneeded-private-text");expect(make(input)).toEqual(first);
 for(const change of [{orgId:"org_bbbbbbbbbbbbbbbbbbbb"},{projectName:"project_2"},{definitionRevision:3},{occurrence:"other-request"}])expect(make({...input,...change}).eventId).not.toBe(first.eventId);
 const selection=events.auditProjectModelSelectionDigestChanged({...base,...selectionFacts,sourceSurface:"slack",...extra});expect(selection.action).toBe("project.model_selection_changed");expect(selection.facts).toEqual(selectionFacts);expect(JSON.stringify(selection)).not.toContain("unneeded-private-text");
 expect(()=>make({...input,afterModelIdsDigest:"bad"})).toThrow();
});

for(const [action,facts] of [["project.models_changed",modelsFacts],["project.model_selection_changed",selectionFacts]] as const)it(`accepts a name-keyed project target for ${action}`,()=>{expect(AUDIT_ACTIONS as readonly string[]).toContain(action);expect(AuditEventInputSchema.safeParse(event(action,facts)).success).toBe(true);expect(AuditEventInputSchema.safeParse({...event(action,facts),target:{kind:"project",name:"private-roadmap"}}).success).toBe(true);expect(AuditEventInputSchema.safeParse({...event(action,facts),target:{kind:"project",id:"opaque-project-reference"}}).success).toBe(true);});
