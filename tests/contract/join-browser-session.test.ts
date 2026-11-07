import { expect,it } from "vitest";
import { identityHarness,httpEvent,OIDC_ISSUER,API } from "../support/developer-fakes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { inviteTokenHash } from "../../packages/broker/src/org/invite-url.js";
const person={sub:"join-browser",name:"Bea",email:"bea@example.test",email_verified:true},owner="f".repeat(64);
for(const outcome of ["joined","ALREADY_IN_ORG","INVITE_WRONG_EMAIL","INVITE_INVALID"] as const)it("only successful invite sign-in gets a browser session: "+outcome,async()=>{
 const h=identityHarness({cloud:{},oidcUsers:[person],slack:false}),orgId=await h.orgs.createOrgWithOwner({name:"Acme",developerId:owner}),id=ownerKeyForSubject(OIDC_ISSUER,person.sub);
 if(outcome==="ALREADY_IN_ORG")await h.orgs.createOrgWithOwner({name:"Existing",developerId:id});
 const {token}=await h.orgs.createInvite({orgId,createdBy:owner,role:"member",...(outcome==="INVITE_WRONG_EMAIL"?{email:"someone@example.test"}:{})});
 const start=await h.http(httpEvent("GET","/v1/auth/join/start?invite="+token)),cookie=start.cookies!.find(value=>value.startsWith("__Host-rovara_join_pkce="))!.split(";")[0]!;
 if(outcome==="INVITE_INVALID")await h.orgs.acceptInvite({tokenHash:inviteTokenHash(token),developerId:"c".repeat(64)});
 const callback=await h.http({...httpEvent("GET",h.oidc.approve(start.headers.location!,person.sub)),headers:{cookie}});
 const sessionCookie=callback.cookies?.find(value=>value.startsWith("__Host-agentx_review_session="));
 if(outcome==="joined"){
  expect(sessionCookie).toMatch(/; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
  const session=await h.deps.store.getSession(sessionCookie!.split(";")[0]!.split("=")[1]!);
  expect(session).toMatchObject({developerId:id,amr:"cloud"});
  const doneUrl=new URL(callback.headers.location!,API),done=await h.http({...httpEvent("GET",doneUrl.pathname+doneUrl.search),headers:{cookie}});
  // UX1: straight into the app on the same origin as the session cookie.
  expect(done.statusCode).toBe(302);expect(done.headers.location).toBe(`${API}/app/welcome?joined=1`);
 }else{expect(sessionCookie).toBeUndefined();expect(h.db.find(item=>String(item.pk).startsWith("SESSION#"))).toHaveLength(0);}
});
it("a later invite page shows the renamed company",async()=>{
 const h=identityHarness({cloud:{},oidcUsers:[],slack:false}),orgId=await h.orgs.createOrgWithOwner({name:"Before",developerId:owner});
 await h.orgs.renameOrg({orgId,developerId:owner,name:"Acme",requestId:"11111111-1111-4111-8111-111111111111"});
 const {token}=await h.orgs.createInvite({orgId,createdBy:owner,role:"member"});const page=await h.http(httpEvent("GET","/v1/auth/join?invite="+token));expect(page.body).toContain("Join Acme on Rovara");
});
