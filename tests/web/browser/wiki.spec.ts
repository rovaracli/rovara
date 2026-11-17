// Lead 4 W5 in the browser, on the pretend Code (which serves Code W2's wiki read routes for the made-up "Beacon" wiki): the project's Wiki tab (page tree, a page at reading width,
// numbered sources in a popover, one freshness chip, a thin note only on the paragraph that needs it, pinned notes read only), search, the empty and edge states, phone width,
// dark mode and the keyboard. Screenshots go to the test output folder.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, WikiPage, setFakePerson, setWiki } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setWiki(page, PROJECT); await setFakePerson(page, "priya"); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { rules: { "color-contrast": { enabled: false } } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}

test("the Wiki tab opens a page with a tree, one meta line, numbered sources and a rail", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.tab).toBeVisible();
  await expect(wiki.article).toBeVisible();
  await expect(wiki.article.getByRole("heading", { level: 2, name: "Product overview" })).toBeVisible();
  await expect(page.getByTestId("wiki-meta")).toContainText("Written by Rovara from the code");
  await expect(wiki.rail).toContainText("Written by Rovara from the code. It can be wrong. The code is the truth.");
  await expect(wiki.treeItem(/^beacon-api/u).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-overview.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
});

test("a source marker opens a popover with the file and lines, closes with Escape and gives focus back", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  const marker = wiki.marker(/^Source 1: beacon-api\/src\/billing\/charge\.ts, lines 42-67$/u).first();
  await marker.focus();
  await page.keyboard.press("Enter");
  const pop = page.getByRole("dialog", { name: "Source 1" });
  await expect(pop).toContainText("beacon-api/src/billing/charge.ts");
  await expect(pop).toContainText("Source found");
  await page.screenshot({ path: testInfo.outputPath("wiki-source-popover.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(marker).toBeFocused();
});

test("only the paragraph that needs it carries a note: stale, not found and marked wrong; pinned notes are read only", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.article.getByText("May be stale.")).toHaveCount(2);
  await expect(wiki.article.getByText("Marked wrong.")).toHaveCount(1);
  await expect(wiki.article.getByRole("complementary", { name: "Note from Priya" })).toContainText("Agents get it after a maintainer approves it.");
  await expect(wiki.article.getByRole("complementary", { name: "Note from Sam" })).toContainText("Pinned for people and agents.");
  await expect(page.getByRole("button", { name: /mark wrong|add a note/iu })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("wiki-billing-notes.png"), fullPage: true });
});

test("the tree opens another page, keeps it in the address and moves focus to its title; the keyboard reaches the tree", async ({ page }) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.article).toBeVisible();
  await wiki.treeItem(/^Glossary/u).focus();
  await page.keyboard.press("Enter");
  await expect(wiki.article.getByRole("heading", { level: 2, name: "Glossary" })).toBeVisible();
  await expect(page).toHaveURL(/page=glossary/u);
  await expect(page.locator("#rv-wiki-title")).toBeFocused();
  await page.goBack();
  await expect(wiki.article.getByRole("heading", { level: 2, name: "Product overview" })).toBeVisible();
});

test("search looks through titles and summaries, and says so when nothing matches", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.article).toBeVisible();
  await wiki.search.fill("refund");
  await expect(wiki.results).toContainText("beacon-api / billing");
  await page.screenshot({ path: testInfo.outputPath("wiki-search.png"), fullPage: true });
  await wiki.results.getByRole("button", { name: /billing/u }).click();
  await expect(wiki.article.getByRole("heading", { level: 2, name: "billing" })).toBeVisible();
  await wiki.search.fill("zzzqqq");
  await expect(page.getByText("No page mentions that. The wiki does not guess.")).toBeVisible();
});

test("a page marked wrong and a page most of whose claims changed say so once, above the text", async ({ page }) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "repo-beacon-agents");
  await expect(wiki.article).toContainText("Someone marked this page wrong. It is hidden from agents until the next refresh rewrites it.");
  await expect(page.getByTestId("wiki-meta")).toContainText("Out of date");
});

test("empty and edge states: no wiki yet, a build running, a stopped build, and a Code with no wiki hides the tab", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await setWiki(page, PROJECT, { state: "none" });
  await wiki.open(PROJECT);
  await expect(wiki.empty).toContainText("No wiki yet");
  await expect(wiki.empty).toContainText("A project admin builds the wiki on Project setup");
  await page.screenshot({ path: testInfo.outputPath("wiki-empty.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
  await setWiki(page, PROJECT, { state: "building" });
  await page.reload();
  await expect(wiki.empty).toContainText("The wiki is being built");
  await setWiki(page, PROJECT, { state: "stopped" });
  await page.reload();
  await expect(page.getByTestId("wiki-build-notice")).toHaveText("The last build stopped at its cost limit.");
  await setWiki(page, PROJECT, { off: true });
  await page.reload();
  await expect(page.getByRole("tab", { name: "How we work" })).toBeVisible();
  await expect(wiki.tab).toHaveCount(0);
  await expect(wiki.wiki).toHaveCount(0);
});

test("a person with a role on the project (Sam) reads the wiki too", async ({ page }) => {
  await setFakePerson(page, "sam");
  await page.context().clearCookies();
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.article).toBeVisible();
});

test("phone width: the tree folds behind Browse pages, the page fills the width, the rail follows the text and nothing scrolls sideways", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.article).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse pages" })).toBeVisible();
  await expect(wiki.search).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("wiki-phone.png"), fullPage: true });
  await page.getByRole("button", { name: "Browse pages" }).click();
  await expect(wiki.search).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-phone-tree.png"), fullPage: true });
  await wiki.treeItem(/^Glossary/u).click();
  await expect(wiki.article.getByRole("heading", { level: 2, name: "Glossary" })).toBeVisible();
  await expect(wiki.search).toBeHidden();
});

test("dark mode keeps the page readable", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.article).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-dark.png"), fullPage: true });
});
