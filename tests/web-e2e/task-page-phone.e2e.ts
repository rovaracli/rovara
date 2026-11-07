import { test,expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
// OWNER DECISION 7: the old review page is read-only. On a phone it still reads in full, sends the owner to the task page to decide, offers nothing to press, and its API refuses a decision.
for(const [theme,width] of [["light",390],["dark",360]] as const)test("reads the plan read-only and sends the owner to the task page at "+width+"px in "+theme,async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"shell"}});await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height:844});await page.goto("/review/11111111-1111-4111-8111-111111111111/task");await expect(page.getByRole("heading",{name:"Retry failed payments",level:1})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--rv-bg").trim())).not.toBe("");
 const decide=page.locator("#decide-on-task");await expect(decide).toHaveAttribute("href","/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa");await expect(decide).toBeVisible();
 await expect(page.locator("button:visible, form, textarea, dialog")).toHaveCount(0);
 await checkA11y(page,{theme});await evidenceShot(page,{path:".test-build/web-e2e/task-page-"+theme+".png",fullPage:true});
 const refused=await page.evaluate(async()=>{const response=await fetch("/review/11111111-1111-4111-8111-111111111111/task/api/decision",{method:"POST",headers:{"content-type":"application/json","x-agentx-csrf":"c".repeat(43)},body:"{}"});return {status:response.status,body:await response.json() as Record<string,unknown>};});
 expect(refused.status).toBe(410);expect(refused.body).toMatchObject({error:"read_only"});
});
