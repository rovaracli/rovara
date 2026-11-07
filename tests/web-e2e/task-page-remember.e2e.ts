import { test,expect } from "./support/csp.js";
// OWNER DECISION 7: the old review page is read-only, so a remembered comment reads as remembered there and the page offers neither Remember nor Forget; both are refused by its API.
// Remember and Forget belong to the task page in Rovara (the React route `/v1/app/projects/{p}/learning/remember`); see the deferral in the slice report.
test("the read-only task page shows a comment and offers no Remember or Forget",async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"shell"}});await request.post("/__mock/task-learning");await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);
 await page.goto("/review/11111111-1111-4111-8111-111111111111/task");
 await expect(page.getByRole("heading",{name:"Retry failed payments",level:1})).toBeVisible();
 await expect(page.getByRole("button",{name:"Remember this"})).toHaveCount(0);
 await expect(page.getByRole("button",{name:"Forget"})).toHaveCount(0);
 const refused=await page.evaluate(async()=>(await fetch("/review/11111111-1111-4111-8111-111111111111/task/api/comments/22222222-2222-4222-8222-222222222222/remember",{method:"POST",headers:{"content-type":"application/json","x-agentx-csrf":"c".repeat(43)},body:"{}"})).status);
 expect(refused).toBe(410);
});
