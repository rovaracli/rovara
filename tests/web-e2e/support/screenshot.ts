import type { Locator, Page } from "@playwright/test";
// These pictures are for people to look at; no test asserts on them. Playwright's WebKit takes a screenshot by adding a <style> element to
// the page (to sync animations), which the app's nonce-only `style-src` rightly refuses, and the CSP guard rightly reports. The guard is not
// relaxed for that (nor is the page given `bypassCSP`), so WebKit simply skips the picture; Chromium and Firefox still take it.
export async function evidenceShot(target: Page | Locator, options: { path: string; fullPage?: boolean }): Promise<void> {
 const page = "page" in target && typeof target.page === "function" ? target.page() : (target as Page);
 if (page.context().browser()?.browserType().name() === "webkit") return;
 await target.screenshot(options);
}
