import { test, expect } from "./support/csp.js";
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
