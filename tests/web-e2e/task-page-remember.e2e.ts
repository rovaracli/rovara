import { test,expect } from "./support/csp.js";
type Sent=Array<{method:string;path:string;body?:Record<string,unknown>}>;
test("a person remembers a comment on the task page, then forgets it",async({page,context,request,baseURL})=>{
 await request.post("/__mock/scenario",{data:{name:"shell"}});await request.post("/__mock/task-learning");await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);
 await page.goto("/review/11111111-1111-4111-8111-111111111111/task");
 const comment=page.locator("#comment-22222222-2222-4222-8222-222222222222");
 await expect(comment).toContainText("Say three tries, not five.");
 await comment.getByRole("button",{name:"Remember this"}).click();
 await expect(comment.getByText("Remembered for this project")).toBeVisible();
 await comment.getByRole("button",{name:"Forget"}).click();
 await expect(comment.getByRole("button",{name:"Remember this"})).toBeVisible();
 await expect(comment.getByText("Remembered for this project")).toHaveCount(0);
 const sent=((await(await request.get("/__mock/requests")).json()) as Sent).filter(item=>item.method==="POST"&&/\/comments\/[^/]+\/(remember|forget)$/.test(item.path));
 expect(sent.map(item=>item.path.split("/").pop())).toEqual(["remember","forget"]);
 expect(sent.every(item=>JSON.stringify(item.body)==="{}")).toBe(true);
});
