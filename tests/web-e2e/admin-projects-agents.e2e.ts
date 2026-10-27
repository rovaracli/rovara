import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async({context,request,baseURL})=>{await request.post("/__mock/scenario",{data:{name:"admin"}});await context.addCookies([{name:"__Host-agentx_review_session",value:FIXTURE_SESSION,url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);});
test("inspects real persisted projects and versions using only reads",async({page,request})=>{
 await page.goto("/app/admin/projects");await expect(page.getByRole("table",{name:"Projects",exact:true})).toBeVisible();await expect(page.getByText("foreign-project")).toHaveCount(0);
 const project=page.getByRole("table").getByRole("link",{name:"payments",exact:true});await project.focus();await page.keyboard.press("Enter");await expect(page.getByRole("heading",{name:"payments",exact:true})).toBeFocused();await expect(page.getByText("Using GitHub default branch")).toBeVisible();await expect(page.getByRole("table",{name:"Project people"})).toBeVisible();
 await page.getByRole("link",{name:"Back to projects"}).click();await page.getByRole("combobox",{name:"Project status"}).selectOption("archived");await expect(page.getByRole("table").getByRole("link",{name:"old",exact:true})).toBeVisible();
 await page.getByRole("link",{name:"Agents",exact:true}).click();await expect(page.getByRole("table",{name:"Visible agents"})).toBeVisible();await expect(page.getByText("Maximum autonomy:",{exact:false})).toBeVisible();
 await page.getByRole("link",{name:"Versions for Rovara Code"}).click();await expect(page.getByRole("table",{name:"Agent versions"})).toBeVisible();await expect(page.getByRole("button",{name:/Adopt|Publish|Save/})).toHaveCount(0);
 const reads=await(await request.get("/__mock/requests")).json() as Array<{method:string;path:string}>;expect(reads.filter(r=>r.path.startsWith("/v1/web/")).every(r=>r.method==="GET")).toBe(true);
});
for(const theme of ["light","dark"] as const)test(`checks B1 pages in ${theme}`,async({page})=>{
 for(const [path,table] of [["projects","Projects"],["projects/payments","Project people"],["agents","Visible agents"],["agents/rovara-code/versions","Agent versions"]]){await page.goto("/app/admin/"+path);await expect(page.getByRole("table",{name:table!,exact:true})).toBeVisible();await checkA11y(page,{theme});}
 await page.screenshot({path:`.superpowers/sdd/codex/b1-versions-${theme}.png`});
});
test("refuses revoked and narrow-screen B1 routes",async({page,request})=>{
 await page.setViewportSize({width:390,height:844});await page.goto("/app/admin/projects");await expect(page.getByText("Open this on a larger screen to use it.",{exact:false})).toBeVisible();await expect(page.getByRole("table")).toHaveCount(0);
 await page.setViewportSize({width:1440,height:1000});await page.goto("/app/admin/agents");await expect(page.getByRole("table")).toBeVisible();await request.post("/__mock/admin-role");await page.reload();await expect(page.getByRole("heading",{name:"Administration unavailable"})).toBeVisible();await expect(page.getByRole("table")).toHaveCount(0);
});

for(const area of ["projects","agents"])test(`keeps keyboard focus on the same ${area} refresh button`,async({page})=>{
 await page.goto("/app/admin/"+area);await expect(page.getByRole("table")).toBeVisible();const button=page.getByRole("button",{name:"Refresh "+area,exact:true}),original=await button.elementHandle();
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),requestStarted=new Promise<void>(resolve=>{started=resolve;});
 const pattern=area==="projects"?"**/v1/web/projects?include=archived":"**/v1/web/agents?scope=all";
 await page.route(pattern,async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await button.focus();await page.keyboard.press("Enter");await requestStarted;await expect(button).toHaveAttribute("aria-busy","true");await expect(button).toBeFocused();expect(await original!.evaluate(node=>node===document.activeElement)).toBe(true);
 release();await expect(button).not.toHaveAttribute("aria-busy","true");expect(await original!.evaluate(node=>node===document.activeElement)).toBe(true);await page.unroute(pattern);
});
for(const area of ["projects","agents"])test(`keeps keyboard focus through ${area} error retry`,async({page})=>{
 const pattern=area==="projects"?"**/v1/web/projects?include=archived":"**/v1/web/agents?scope=all";let reads=0,release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),requestStarted=new Promise<void>(resolve=>{started=resolve;});
 await page.route(pattern,async route=>{if(++reads===1){await route.fulfill({status:403,json:{error:{code:"FORBIDDEN",message:"Synthetic refusal"}}});return;}const response=await route.fetch();started();await gate;await route.fulfill({response});});
 await page.goto("/app/admin/"+area);const button=page.getByRole("button",{name:"Try again",exact:true});await expect(button).toBeVisible();const original=await button.elementHandle();await button.focus();await page.keyboard.press("Enter");await requestStarted;expect(await original!.evaluate(node=>node.isConnected && node===document.activeElement)).toBe(true);
 release();await expect(page.getByRole("table")).toBeVisible();expect(await original!.evaluate(node=>node===document.activeElement)).toBe(true);await expect(page.getByRole("button",{name:"Refresh "+area,exact:true})).toBeFocused();await page.unroute(pattern);
});
