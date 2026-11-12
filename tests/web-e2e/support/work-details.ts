import type { Page } from "@playwright/test";
/**
 * On a phone the task page keeps its work and evidence behind one disclosure, "Work details and evidence" (the phone order of the leading header, owner decision 40; always on since decision 125).
 * It opens by itself when something inside needs the reader (Understand's questions to answer, a Merge to press: owner decision of 2026-11-12) and when the address names a tab (`#changes`).
 * A test that resizes to a phone width and then reads the work (the pipeline, an answer, a diff, Understand's questions) calls this first: it waits for the phone order to be drawn (a resize is
 * not instant), gives the page a moment to open the disclosure itself, and clicks it open only when the page did not (a click on one the page opened would close it).
 */
export async function openWorkDetails(page: Page): Promise<void> {
 const details = page.locator("details.rv-session-evidence"), summary = details.locator(":scope > summary");
 await summary.waitFor();
 const isOpen = () => details.evaluate(node => (node as HTMLDetailsElement).open);
 if (await isOpen()) return;
 await page.waitForFunction(() => document.querySelector<HTMLDetailsElement>("details.rv-session-evidence")?.open === true, undefined, { timeout: 300 }).catch(() => undefined);
 if (await isOpen()) return;
 await summary.click();
}
