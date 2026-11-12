import { test,expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { mockRealtime } from "./support/realtime.js";
import { navFixture } from "../web/support/fixtures.js";
import { AppNavSchema } from "@agentx/cloud-contracts/web";
const sid="ses_aaaaaaaaaaaaaaaaaaaa",agentId="agt_aaaaaaaaaaaaaaaaaaaa",payload="<img src=x onerror=window.__pwned=1>";
const flows=[
 {name:"Home",scenario:"home",path:"/app",heading:"Home",phone:true},
 // Work, since decision 125 (the old Live page is gone; /app/live lands on Work).
 {name:"Work",scenario:"live",path:"/app/work",heading:"Work",phone:true},
 {name:"project",scenario:"project",path:"/app/projects/payments",heading:"payments",phone:true},
 {name:"task session",scenario:"workspace",path:"/app/sessions/"+sid,heading:"Fix duplicate refunds",phone:true},
 {name:"local session",scenario:"session",path:"/app/sessions/"+sid,heading:"Fix duplicate refunds",phone:true},
 // PLAN6: question/Merge controls and code starts are excluded; verify the readable existing code-task projection only.
 {name:"code task projection",scenario:"workspace",path:"/app/sessions/"+sid,heading:"Fix duplicate refunds",phone:true,code:true},
 {name:"directory",scenario:"agents",path:"/app/agents",heading:"Agent directory",phone:true},
 {name:"profile",scenario:"agents",path:"/app/agents/"+agentId,heading:"Payments Expert",phone:true},
 {name:"builder",scenario:"builder",path:"/app/agents/"+agentId+"/edit",heading:"Payments Expert",phone:false},
 {name:"readonly builder",scenario:"builder",path:"/app/agents/"+agentId+"/edit",heading:"Payments Expert",phone:false,readonly:true},
 // PLAN6: setup-draft authoring belongs to excluded Task18b; the actual manual setup flow is covered separately.
 {name:"onboarding",scenario:"onboarding",path:"/app/onboard?github=connected",heading:"Onboard a project",phone:true,onboarding:true},
 {name:"shared link",scenario:"workspace",path:"/s/"+sid,heading:"Fix duplicate refunds",phone:true},
 {name:"signup",scenario:"shell",path:"/app/signup",heading:"Start with Rovara",phone:true},
 {name:"signed out",scenario:"shell",path:"/app/signed-out",heading:"Sign in to Rovara",phone:true},
] as const;
for(const theme of ["light","dark"] as const)for(const flow of flows)test(flow.name+" accessibility, safe input, focus and reflow in "+theme,async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:flow.scenario}});await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);await mockRealtime(page);await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
 if("onboarding"in flow)await request.get("/__mock/github-install");
 if("code"in flow)await request.post("/__mock/session-state",{data:{agent:{agentId:"rovara-code",name:"Rovara Code",version:1}}});
 if("readonly"in flow)await request.post("/__mock/agent-state",{data:{access:"view"}});
 await page.goto(flow.path);const heading=page.getByRole("heading",{name:flow.heading,level:1,exact:true});await expect(heading).toBeVisible();
 await checkA11y(page,{theme});await heading.focus();
 // Safari on macOS (and so Playwright's WebKit there) skips links and buttons on Tab unless Option is held; other engines take every control.
 await page.keyboard.press(process.platform==="darwin"&&page.context().browser()?.browserType().name()==="webkit"?"Alt+Tab":"Tab");await expect(page.locator(":focus")).toBeVisible();expect(await page.locator(":focus").evaluate(node=>{const css=getComputedStyle(node);return css.outlineStyle!=="none"&&parseFloat(css.outlineWidth)>0;})).toBe(true);
 expect(await page.evaluate(()=>[...document.querySelectorAll("main *")].every(node=>{const css=getComputedStyle(node);return css.animationName==="none"&&css.transitionDuration.split(",").every(value=>parseFloat(value)===0);}))).toBe(true);
 for(const field of await page.getByRole("textbox").all()){if(await field.isVisible()&&await field.isEditable())await field.fill(payload);}
 expect(await page.evaluate(()=>Reflect.get(window,"__pwned") as unknown)).toBeUndefined();expect(await page.locator("main img[src=x]").count()).toBe(0);
 if(flow.phone){await page.setViewportSize({width:640,height:900});await page.evaluate(()=>{document.documentElement.style.zoom="2";});await expect(heading).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>{document.documentElement.style.zoom="1";});await page.setViewportSize({width:320,height:844});await expect(heading).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await checkA11y(page,{theme});}
 else{await page.setViewportSize({width:320,height:844});await expect(page.getByRole("heading",{name:"Open on a larger screen"})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
});
test("Bo sees Not found for another organization's session, project and agent URLs",async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"agents"}});await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);await mockRealtime(page);
 await page.route("**/v1/web/nav",route=>route.fulfill({json:AppNavSchema.parse(navFixture({me:{developerId:"b".repeat(64),name:"Bo",orgRole:"member"},org:{name:"Other organization"},projects:[],shared:{agents:[],sessions:[]},homeCount:0}))}));
 for(const path of ["/v1/web/sessions/"+sid,"/v1/web/projects/payments/overview","/v1/web/agents/"+agentId])await page.route("**"+path,route=>route.fulfill({status:404,json:{error:{code:"NOT_FOUND",message:"Not found."}}}));
 for(const path of ["/s/"+sid,"/app/projects/payments","/app/agents/"+agentId]){await page.goto(path);await expect(page.getByRole("heading",{name:"Not found",exact:true})).toBeVisible();await expect(page.getByText("We couldn't find that. It may not exist, or it hasn't been shared with you.")).toBeVisible();}
 // This is the app's 404 treatment, not proof of server isolation; canonical cross-org contract tests own that boundary.
});
for(const theme of ["light","dark"] as const)test("collaboration and published notes keep hostile input inert in "+theme,async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"workspace"}});await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);await mockRealtime(page);await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});await page.goto("/s/"+sid);await page.getByRole("button",{name:"Conversation",exact:true}).click();const comment=page.getByRole("textbox",{name:"Comment",exact:true});await comment.fill(payload);const sent=page.waitForRequest(input=>input.method()==="POST"&&new URL(input.url()).pathname.endsWith("/messages"));await page.getByRole("button",{name:"Send comment"}).click();expect(((await sent).postDataJSON() as {text:string}).text).toBe(payload);await expect(comment).toHaveValue("");expect(await page.evaluate(()=>Reflect.get(window,"__pwned") as unknown)).toBeUndefined();await checkA11y(page,{theme});
 await request.post("/__mock/scenario",{data:{name:"builder"}});await page.goto("/app/agents/"+agentId+"/edit");await page.getByRole("textbox",{name:"Additional instructions",exact:true}).fill(payload);await expect(page.getByText("Saved",{exact:true})).toBeVisible();await page.getByRole("button",{name:"Publish",exact:true}).click();const publish=page.getByRole("dialog",{name:"Review and publish"});await publish.getByRole("textbox",{name:"Version note"}).fill(payload);await expect(publish.getByRole("button",{name:"Publish this draft"})).toBeEnabled();await publish.getByRole("button",{name:"Publish this draft"}).click();await expect(publish.getByText("Published version 4",{exact:true})).toBeVisible();await publish.getByRole("button",{name:"Close dialog"}).click();await page.getByText("Versions and history",{exact:true}).click();
 // Scoped to the Versions region: Firefox also exposes the instructions textarea's value as text, so an unscoped getByText matches two elements. The probe must show as text here, and the __pwned and img checks below still prove it never ran.
 await expect(page.getByRole("region",{name:"Versions"}).getByText(payload,{exact:true})).toBeVisible();expect(await page.evaluate(()=>Reflect.get(window,"__pwned") as unknown)).toBeUndefined();expect(await page.locator("main img[src=x]").count()).toBe(0);await checkA11y(page,{theme});
});
