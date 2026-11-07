import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa";
test("keeps plan and file evidence stable while teammates discuss their actual context", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 const realtime = await mockRealtime(page);await page.goto("/app/sessions/" + id + "#plan");
 await expect(page.getByRole("heading", { name: "Refund investigation" })).toBeVisible();await expect(page.locator("h1")).toHaveCount(1);
 const paragraph = await page.getByText("Check the idempotency key.", { exact: true }).elementHandle();
 const source = page.getByRole("button", { name: "Comment on plan paragraph 2" });const sourceElement = await source.elementHandle();
 await source.click();await expect(page.getByRole("dialog", { name: "Discussion of this plan paragraph" })).toBeVisible();await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
 await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Check this refund assumption");await page.getByRole("button", { name: "Send comment" }).click();await expect(page.getByText("Check this refund assumption", { exact: true })).toBeVisible();
 const writes = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string; body?: { anchor?: unknown } }>;
 expect(writes.find(row => row.method === "POST" && row.path.endsWith("/messages"))?.body?.anchor).toEqual({ target: "plan_block", targetId: "p2", revision: "v1" });
 await request.post("/__mock/session-state", { data: { revision: 2, updatedAt: new Date().toISOString() } });await expect.poll(() => realtime.connections()).toBeGreaterThanOrEqual(1);await realtime.push({ type: "session.updated", sessionId: id, revision: 2 });
 await expect.poll(async () => ((await (await request.get("/__mock/requests")).json()) as typeof writes).filter(row => row.method === "GET" && row.path === "/v1/web/sessions/" + id).length).toBeGreaterThanOrEqual(2);
 expect(await paragraph?.evaluate(node => node.isConnected)).toBe(true);expect(await sourceElement?.evaluate(node => node.isConnected)).toBe(true);
 await page.getByRole("button", { name: "Close dialog" }).click();await expect(source).toBeFocused();
 await page.getByRole("tab", { name: "Changes", exact: true }).click();await expect(page.getByText("12 lines added, 3 removed")).toBeVisible();const fileSource = page.getByRole("button", { name: "Comment on src/refund.ts" });await fileSource.click();
 await expect(page.getByRole("button", { name: "Message the agent" })).toHaveCount(0);await page.getByRole("textbox", { name: "Comment", exact: true }).fill("<img src=x onerror=window.__pwned=1>");await page.getByRole("button", { name: "Send comment" }).click();await expect(page.getByText("<img src=x onerror=window.__pwned=1>", { exact: true })).toBeVisible();
 expect(await page.evaluate(() => "__pwned" in window)).toBe(false);await page.getByRole("button", { name: "Close dialog" }).click();await expect(fileSource).toBeFocused();
 await page.getByRole("tab", { name: "Plan", exact: true }).focus();await page.keyboard.press("Enter");await expect(page).toHaveURL(/#plan$/u);await page.reload();await expect(page.getByRole("heading", { name: "Refund investigation" })).toBeVisible();
 await evidenceShot(page, { path: ".test-build/web-e2e/workspace-desktop.png", fullPage: true });
 await page.setViewportSize({ width: 360, height: 800 });expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: ".test-build/web-e2e/workspace-phone-dark.png", fullPage: true });
});

test("a chain run link says this isn't available, with a link home",async({page,context,request,baseURL})=>{
 const {chainRunViewOf}=await import("../web/support/chain-fixture.js"),runId="crn_"+"a".repeat(20);
 await request.post("/__mock/scenario",{data:{name:"workspace"}});await request.post("/__mock/session-state",{data:{sessionId:runId,kind:"chain",body:{kind:"chain",chain:chainRunViewOf(runId,{project:"payments"})},link:baseURL+"/s/"+runId}});
 await context.addCookies([{name:"__Host-agentx_review_session",value:"11111111-1111-4111-8111-111111111111",url:baseURL!,secure:true,httpOnly:true,sameSite:"Strict"}]);await mockRealtime(page);
 for(const path of ["/app/sessions/"+runId,"/app/chains/chn_aaaaaaaaaaaaaaaaaaaa","/app/triggers/trg_aaaaaaaaaaaaaaaaaaaa"]){
  await page.goto(path);await expect(page.getByRole("heading",{name:"This isn't available",level:1})).toBeVisible();await expect(page.getByRole("link",{name:"Go to Home"})).toBeVisible();await expect(page.getByText("Chain progress")).toHaveCount(0);
 }
 await checkA11y(page,{theme:"light"});await checkA11y(page,{theme:"dark"});
});
