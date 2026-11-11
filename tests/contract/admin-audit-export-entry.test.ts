import { readFileSync } from "node:fs";
import { AUDIT_EXPORT_ENTRY_PATH, AUDIT_VERIFIER_EXTENDS_EXAMPLE } from "../../packages/ui/src/screens/admin/audit/metadata.js";
import { expect, it } from "vitest";
import type { OrgRole } from "@agentx/cloud-contracts";
import { createAuditViewPage, AUDIT_VIEW_PATH, AUDIT_VIEW_EXPORT_PATH, type AuditViewCaller } from "../../packages/broker/src/audit/view-page.js";
import { SESSION_COOKIE, CSRF_COOKIE } from "../../packages/broker/src/aws/web-session.js";
import { A, B } from "../support/audit-anchor-harness.js";
import { world, type Bench } from "../support/audit-routes-bench.js";
const origin="https://cell.example", session="11111111-1111-4111-8111-111111111111", csrf="c".repeat(43);
function entry(b:Bench, role:string="owner", orgId:string=A) {
 const state:{caller:AuditViewCaller|undefined}={caller:{developerId:"dev_1",orgId,orgRole:role as OrgRole}};
 const handle=createAuditViewPage({origin,ledger:b.deps,authenticateSession:async id=>id===session?state.caller:undefined});
 const get=(path=AUDIT_VIEW_PATH)=>handle({method:"GET",path,requestId:"read-entry",headers:{cookie:`${SESSION_COOKIE}=${session}`}},new URL(path,origin));
 const post=(requestId="export-entry",options:{origin?:string;field?:string;cookie?:string;extra?:Record<string,string>}={})=>handle({method:"POST",path:AUDIT_VIEW_EXPORT_PATH,requestId:"post-entry",headers:{origin:options.origin??origin,"content-type":"application/x-www-form-urlencoded",cookie:`${SESSION_COOKIE}=${session}; ${CSRF_COOKIE}=${options.cookie??csrf}`},body:new URLSearchParams({csrf:options.field??csrf,requestId,fromSeq:"1",toSeq:"2",...options.extra}).toString()},new URL(AUDIT_VIEW_EXPORT_PATH,origin));
 return{state,get,post};
}
for(const role of ["owner","admin","maintainer","member","viewer","future-role"])it(`the reused native export flow enforces the live ${role} role`,async()=>{
 const b=await world(),flow=entry(b,role),allowed=role==="owner"||role==="admin",before=b.h.operations.length;
 const page=await flow.get();expect(page.statusCode).toBe(allowed?200:403);if(!allowed){expect(b.h.operations.length).toBe(before);expect(page.body).not.toContain("Person of");}
 const reply=await flow.post("role-"+role);expect(reply.statusCode).toBe(allowed?303:403);expect(b.invocations).toHaveLength(allowed?1:0);
 if(allowed){const id=b.invocations[0]!.exportId;expect(b.h.db.get({pk:`ORG#${A}#AUDIT_EXPORT#${id}`,sk:"META"})).toMatchObject({orgId:A,status:"running",withDetails:false,range:{fromSeq:1,toSeq:2}});}
});
it("the native form rechecks demotion and revoked membership after opening",async()=>{
 const b=await world(),flow=entry(b);expect((await flow.get()).statusCode).toBe(200);flow.state.caller={developerId:"dev_1",orgId:A,orgRole:"member"};expect((await flow.post("demoted")).statusCode).toBe(403);flow.state.caller=undefined;expect((await flow.post("revoked")).statusCode).toBe(401);expect(b.invocations).toHaveLength(0);
});
for(const bad of [{origin:"https://other.example"},{field:"d".repeat(43)},{cookie:"e".repeat(43)}] as const)it("the native export refuses a mismatched Origin or CSRF pair",async()=>{
 const b=await world(),flow=entry(b);expect((await flow.post("refused",bad)).statusCode).toBe(403);expect(b.invocations).toHaveLength(0);
});
it("the native flow scopes export IDs and form inputs to the current company",async()=>{
 const b=await world(),flow=entry(b);expect((await flow.post("same-request")).statusCode).toBe(303);const aId=b.invocations[0]!.exportId;
 flow.state.caller={developerId:"dev_b",orgId:B,orgRole:"owner"};const other=await flow.get(AUDIT_VIEW_PATH+"?export="+aId);expect(other.statusCode).toBe(200);expect(other.body).toContain("That export was not found.");expect(other.body).not.toContain(`Person of ${A}`);expect(b.presigned).toHaveLength(0);
 expect((await flow.post("foreign-field",{extra:{orgId:A}})).statusCode).toBe(400);expect(b.invocations).toHaveLength(1);expect((await flow.post("same-request")).statusCode).toBe(303);expect(b.invocations[1]!.orgId).toBe(B);expect(b.invocations[1]!.exportId).not.toBe(aId);expect(b.h.db.get({pk:`ORG#${A}#AUDIT_EXPORT#${aId}`,sk:"META"})?.orgId).toBe(A);
});

it("the console handoff targets the existing bounded protected form without identity parameters",async()=>{
 const target=new URL(AUDIT_EXPORT_ENTRY_PATH,origin);expect(target.pathname).toBe(AUDIT_VIEW_PATH);expect([...target.searchParams]).toEqual([["limit","1"]]);expect(target.hash).toBe("#export-form");const b=await world(),flow=entry(b);const response=await flow.get(AUDIT_EXPORT_ENTRY_PATH);expect(response.statusCode).toBe(200);expect(response.body).toContain('id="export-form"');expect(b.invocations).toHaveLength(0);
});
it("the local free verifier guidance matches the offline README example",()=>{
 const readme=readFileSync("packages/audit-verifier/README.md","utf8");expect(readme).toContain(AUDIT_VERIFIER_EXTENDS_EXAMPLE);expect(readme).toContain("needs Node 22");expect(readme).toContain("talks to no network");
});
