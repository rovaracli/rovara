import { test } from "./support/csp.js";
test("positive control: the CSP guard rejects a deliberately blocked script", async ({ page, context, baseURL, request }) => {
 test.setTimeout(5000);
 test.fail(true, "The automatic CSP assertion must reject this deliberately blocked operation.");
 await request.post("/__mock/scenario", { data: { name: "shell" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);await page.goto("/app");
 await page.evaluate(() => new Promise<void>(resolve => {
 window.addEventListener("securitypolicyviolation", () => resolve(), { once: true });
 try { const script = document.createElement("script");script.src = "https://blocked.invalid/csp-probe.js";document.head.appendChild(script); } catch { /* This independent listener proves the browser blocked the DOM operation. */ }
 }));
 // A navigation must not erase the guard's evidence.
 await page.goto("/app/live");
});
