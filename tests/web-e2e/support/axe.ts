import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
export async function checkA11y(page: Page, { theme }: { theme: "light" | "dark" }) {
 await page.emulateMedia({ colorScheme: theme });
 // The page's elements can be there before its stylesheet is applied (a slow runner: in the 0.5.11 CI run the app's CSS arrived 160 ms after the scan began, so the scan saw an unstyled page and reported `target-size`
 // on the skip link and the sidebar, and axe's own inline <style> for the unread sheet tripped the CSP guard). Scan only once every stylesheet link has loaded and fonts are ready. A link that never loads times out here.
 await page.waitForFunction(() => [...document.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet]")].every(link => link.sheet !== null), undefined, { timeout: 10_000 });
 await page.evaluate(async () => { await document.fonts.ready; });
 const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
 expect(result.violations.map(value => ({ id: value.id, impact: value.impact, nodes: value.nodes.map(node => node.target) }))).toEqual([]);
}
