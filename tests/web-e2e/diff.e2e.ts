import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { openWorkDetails } from "./support/work-details.js";
test("loads the selected PR diff on demand with safe patch text and bounded paging", async ({ page, context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "workspace" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.goto("/app/sessions/ses_aaaaaaaaaaaaaaaaaaaa#changes");
 await page.getByRole("button", { name: "View diff for acme/payments #42" }).click();
 const patch = page.locator('pre[aria-label="Diff for src/refund.ts"]');
 await expect(patch).toContainText("</pre><script>window.__pwned=1</script>");await expect(patch.locator("script")).toHaveCount(0);
 expect(await page.evaluate(() => "__pwned" in window)).toBe(false);
 await page.getByRole("button", { name: "Load more files" }).click();
 await expect(page.getByRole("link", { name: "Open on GitHub" })).toBeVisible();await expect(page.getByRole("button", { name: "Load more files" })).toHaveCount(0);
 await page.locator('summary').first().click();await expect(patch).toBeHidden();
 await page.locator('summary').first().click();
 await evidenceShot(page, { path: ".test-build/web-e2e/diff-desktop.png", fullPage: true });
 await checkA11y(page, { theme: "light" });await page.setViewportSize({ width: 360, height: 800 });await openWorkDetails(page);
 // The phone order is another page tree (the resize draws it afresh), so the diff is asked for again on the phone.
 await page.getByRole("button", { name: "View diff for acme/payments #42" }).click();await patch.focus();await expect(patch).toBeFocused();await checkA11y(page, { theme: "dark" });expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);await evidenceShot(page, { path: ".test-build/web-e2e/diff-phone-dark.png", fullPage: true });
});
