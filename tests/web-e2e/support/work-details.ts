import type { Page } from "@playwright/test";
/**
 * On a phone the task page keeps its work and evidence behind one disclosure, "Work details and evidence" (the phone order of the leading header, owner decision 40; always on since decision 125).
 * A test that resizes to a phone width and then reads the work (the pipeline, an answer, a diff, Understand's questions) calls this first: it waits for the phone order to be drawn (a resize is
 * not instant) and opens the disclosure, leaving it alone when it is already open (an address with a hash, such as `#changes`, opens it).
 */
export async function openWorkDetails(page: Page): Promise<void> {
 const details = page.locator("details.rv-session-evidence"), summary = details.locator(":scope > summary");
 await summary.waitFor();
 if (await details.evaluate(node => (node as HTMLDetailsElement).open)) return;
 await summary.click();
}
