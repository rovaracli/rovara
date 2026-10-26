import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
export async function checkA11y(page: Page, { theme }: { theme: "light" | "dark" }) {
 await page.emulateMedia({ colorScheme: theme });
 const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
 expect(result.violations.map(value => ({ id: value.id, impact: value.impact, nodes: value.nodes.map(node => node.target) }))).toEqual([]);
}
