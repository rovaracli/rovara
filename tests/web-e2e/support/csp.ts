import { test as base, expect } from "@playwright/test";
import { mockCellOrigin } from "./port.js";
export const test = base.extend<{ cspGuard: void }>({
 // Each worker slot talks to its own mock cell process (playwright.config.ts starts one per slot), so the base URL is the one of this worker's slot. A restarted worker keeps its slot (parallelIndex).
 // Playwright reads the fixtures a function needs from a destructuring pattern in its first parameter, so the empty pattern stays.
 // eslint-disable-next-line no-empty-pattern
 baseURL: [async ({}, use, testInfo) => { await use(mockCellOrigin(testInfo.parallelIndex)); }, { scope: "test" }],
 cspGuard: [async ({ context }, use) => {
 const records: string[] = [];
 await context.exposeBinding("__rovaraReportCsp", (_source, value: unknown) => {
 const safe = typeof value === "string" && /^[a-z-]+:(?:\/app\/assets\/[A-Za-z0-9._-]+|\[page\]):[0-9]+:[0-9]+:[a-z0-9+.-]+$/u.test(value) ? value : "CSP_VIOLATION";
 if (records.length < 100) records.push(safe);
 });
 await context.addInitScript(() => {
 window.addEventListener("securitypolicyviolation", event => {
 let script = "[page]";
 try { const source = new URL(event.sourceFile);if (source.origin === location.origin && /^\/app\/assets\/[A-Za-z0-9._-]+$/u.test(source.pathname)) script = source.pathname; } catch { /* No source content is evidence. */ }
 // Only the blocked resource's scheme (or the keyword inline/eval) is kept, so a blocked image reports "data" or "blob" without its URL.
 let blocked = "unknown";
 try { const raw = String(event.blockedURI);blocked = /^(?:inline|eval|data|blob|self)$/u.test(raw) ? raw : new URL(raw).protocol.slice(0, -1).toLowerCase();if (!/^[a-z][a-z0-9+.-]*$/u.test(blocked)) blocked = "unknown"; } catch { /* An unparsable URI is reported as unknown. */ }
 const directive = /^[a-z-]+$/u.test(event.effectiveDirective) ? event.effectiveDirective : "unknown-directive";
 void window.__rovaraReportCsp(`${directive}:${script}:${event.lineNumber}:${event.columnNumber}:${blocked}`);
 });
 });
 await use();
 // The Node-side record survives redirects and popup closure; no URL query, sample, token or cookie is retained.
 expect(records).toEqual([]);
 }, { auto: true }] });
export { expect };
declare global { interface Window { __rovaraReportCsp(value: string): Promise<void> } }
