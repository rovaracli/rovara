import { test as base, expect } from "@playwright/test";
// Playwright's WebKit puts an inline <style> into the page while it takes a screenshot (to hide the caret and settle animations), and the page's CSP, which has no
// 'unsafe-inline', blocks it. That report comes from the test tool, not the app, so the guard ignores `style-src-elem` reports while a screenshot is in flight.
let screenshotsInFlight = 0;
export const test = base.extend<{ cspGuard: void }>({
 page: async ({ page }, use) => {
 const take = page.screenshot.bind(page);
 page.screenshot = (async (options?: Parameters<typeof take>[0]) => {
 screenshotsInFlight += 1;
 try { return await take(options); } finally { await page.evaluate(() => undefined).catch(() => undefined);screenshotsInFlight -= 1; }
 }) as typeof take;
 await use(page);
 },
 cspGuard: [async ({ context }, use) => {
 const records: string[] = [];
 await context.exposeBinding("__rovaraReportCsp", (_source, value: unknown) => {
 if (screenshotsInFlight > 0 && typeof value === "string" && value.startsWith("style-src-elem:[page]:")) return;
 const safe = typeof value === "string" && /^[a-z-]+:(?:\/app\/assets\/[A-Za-z0-9._-]+|\[page\]):[0-9]+:[0-9]+$/u.test(value) ? value : "CSP_VIOLATION";
 if (records.length < 100) records.push(safe);
 });
 await context.addInitScript(() => {
 window.addEventListener("securitypolicyviolation", event => {
 // Firefox also asks for /favicon.ico on a page whose CSP allows no images (the confirmation page, `default-src 'none'`) and reports that request; the page has no icon to load.
 if (event.effectiveDirective === "img-src" && event.blockedURI === location.origin + "/favicon.ico") return;
 let script = "[page]";
 try { const source = new URL(event.sourceFile);if (source.origin === location.origin && /^\/app\/assets\/[A-Za-z0-9._-]+$/u.test(source.pathname)) script = source.pathname; } catch { /* No source content is evidence. */ }
 const directive = /^[a-z-]+$/u.test(event.effectiveDirective) ? event.effectiveDirective : "unknown-directive";
 void window.__rovaraReportCsp(`${directive}:${script}:${event.lineNumber}:${event.columnNumber}`);
 });
 });
 await use();
 // The Node-side record survives redirects and popup closure; no URL query, sample, token or cookie is retained.
 expect(records).toEqual([]);
 }, { auto: true }] });
export { expect };
declare global { interface Window { __rovaraReportCsp(value: string): Promise<void> } }
