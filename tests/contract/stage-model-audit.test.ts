import {expect,it} from "vitest";
import {AUDIT_ACTIONS,AuditEventInputSchema,auditEventId} from "../../packages/contracts/src/index.js";
const base={eventId:auditEventId("model_source.order_changed","test"),orgId:"org_aaaaaaaaaaaaaaaaaaaa",actor:{kind:"member" as const,id:"dev_1"},target:{kind:"project",name:"private-roadmap"},occurredAt:"2026-10-29T23:00:00.000Z"};
it("registers all G3 actions before writers and accepts only fixed vocabulary and digests",()=>{
 for(const action of ["model_policy.changed","model_policy.lock_set","model_policy.lock_removed","model.fallback_used"]) expect(AUDIT_ACTIONS).toContain(action);
 const facts={stage:"build",cause:"DEFAULT_MODEL_UNAVAILABLE",usedModelDigest:"a".repeat(64),companyRevision:0};
 expect(AuditEventInputSchema.safeParse({...base,action:"model.fallback_used",facts}).success).toBe(true);
 for(const bad of [{...facts,usedModelDigest:"anthropic/claude-sonnet-4"},{...facts,stage:"secret stage"},{...facts,cause:"raw provider exception"},{...facts,model:"raw"}]) expect(AuditEventInputSchema.safeParse({...base,action:"model.fallback_used",facts:bad}).success).toBe(false);
 for(const action of ["model_policy.changed","model_policy.lock_set","model_policy.lock_removed"]){const facts={revision:1,policyDigest:"a".repeat(64)};expect(AuditEventInputSchema.safeParse({...base,action,facts}).success).toBe(true);expect(AuditEventInputSchema.safeParse({...base,action,facts:{...facts,policyDigest:"raw model name"}}).success).toBe(false);}
});

it("builds fallback events with hashed model identities and stable occurrence ids",async()=>{
 const {auditModelFallbackUsed}=await import("../../packages/broker/src/audit/events.js");
 const input={orgId:base.orgId,actor:{kind:"member" as const,id:"dev_1"},occurredAt:base.occurredAt,occurrence:"task-1-build-attempt-1",projectName:"private-roadmap",stage:"build" as const,used:{provider:"anthropic",modelId:"private-model"},reasonCode:"DEFAULT_MODEL_UNAVAILABLE" as const,companyRevision:0};
 const event=auditModelFallbackUsed(input);expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
 expect(event.target).toEqual({kind:"project",name:input.projectName});expect(event.facts?.usedModelDigest).toMatch(/^[a-f0-9]{64}$/u);expect(JSON.stringify(event)).not.toContain("private-model");
 expect(auditModelFallbackUsed(input).eventId).toBe(event.eventId);expect(auditModelFallbackUsed({...input,occurrence:"task-1-build-attempt-2"}).eventId).not.toBe(event.eventId);
});
it("records the shared approval decision mode for company loosening without arbitrary approval text",async()=>{
 const {auditModelPolicyChanged}=await import("../../packages/broker/src/audit/events.js");
 for(const mode of ["second_person","sole_owner_exception"] as const){
  const facts={revision:2,policyDigest:"a".repeat(64),mode};
  expect(AuditEventInputSchema.safeParse({...base,target:{kind:"org",id:base.orgId},action:"model_policy.changed",facts}).success).toBe(true);
  expect(auditModelPolicyChanged({orgId:base.orgId,actor:base.actor,occurredAt:base.occurredAt,occurrence:"policy-mode-1",revision:2,policyDigest:"a".repeat(64),mode}).facts).toEqual(facts);
 }
 expect(AuditEventInputSchema.safeParse({...base,action:"model_policy.changed",facts:{revision:2,policyDigest:"a".repeat(64),mode:"approved by private-person"}}).success).toBe(false);
});
