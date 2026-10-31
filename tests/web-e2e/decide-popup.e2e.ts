import { test, expect } from "./support/csp.js";
import { evidenceShot } from "./support/screenshot.js";
test("a confirmation popup severs its app opener and no decision is posted", async ({ page, request, context, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "shell" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
 const popup = page.waitForEvent("popup");await page.evaluate(() => { window.__confirmationPopup = window.open("/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa"); });
 const confirmation = await popup;await expect(confirmation.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
 await expect.poll(() => page.evaluate(() => { try { return window.__confirmationPopup?.closed === true || window.__confirmationPopup?.document === undefined; } catch { return true; } })).toBe(true);
 const attempted = await page.evaluate(() => { try { const button = window.__confirmationPopup?.document.querySelector<HTMLButtonElement>('button[value="approve"]');button?.click();return button !== undefined && button !== null; } catch { return false; } });expect(attempted).toBe(false);
 const requests = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(requests.filter(value => value.method === "POST" && value.path.startsWith("/v1/app/approve/"))).toEqual([]);await confirmation.close();
});
declare global { interface Window { __confirmationPopup?: Window | null } }

test("a refused model confirmation exposes a keyboard-accessible safe repair link",async({page})=>{
 const {resultPage}=await import("../../packages/broker/src/developer/confirm-page.js");
 const result=resultPage("Approved, but it did not go through","build: STAGE_LOCKED: Review How we work.","/app/admin/how-we-work");
 await page.route("**/__c53-confirmation-result",route=>route.fulfill({status:result.statusCode,headers:result.headers,body:result.body}));
 await page.goto("/__c53-confirmation-result");const link=page.getByRole("link",{name:"Review model settings"});await expect(link).toHaveAttribute("href","/app/admin/how-we-work");// WebKit tabs to links only with Option held, as in part-a-sweep.
 await page.keyboard.press(page.context().browser()?.browserType().name()==="webkit"?"Alt+Tab":"Tab");await expect(link).toBeFocused();
 await evidenceShot(page,{path:".test-build/web-e2e/c53-confirmation-repair.png",fullPage:true});
});
