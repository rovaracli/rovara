// Lead 4 W5 in the browser, on the pretend Code (which serves Code W2's wiki read routes for the made-up "Beacon" wiki): the project's Wiki tab (page tree, a page at reading width,
// numbered sources in a popover, one freshness chip, a thin note only on the paragraph that needs it, pinned notes read only), search, the empty and edge states, phone width,
// dark mode and the keyboard. Screenshots go to the test output folder.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, WikiPage, setFakePerson, setWiki } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setWiki(page, PROJECT); await setFakePerson(page, "priya"); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page, contrast = false): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async (enabled) => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { rules: { "color-contrast": { enabled } } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  }, contrast);
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
  await expect(wiki.article.getByRole("group", { name: "Note from Priya" })).toContainText("Agents get it after a maintainer approves it.");
  await expect(wiki.article.getByRole("group", { name: "Note from Sam" })).toContainText("Pinned for people and agents.");
  // Priya is an administrator: she is offered the corrections (C1), and the paragraph already marked wrong has no Mark wrong button.
  await expect(wiki.article.getByRole("button", { name: /^Mark wrong/u })).toHaveCount(4);
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
  // Colour contrast of the chips, notes and status words, in both themes (the other checks leave contrast off).
  expect(await violations(page, true)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(wiki.article).toBeVisible();
  expect(await violations(page, true)).toEqual([]);
});

test("corrections: a person adds a note and marks a paragraph wrong; a maintainer approves the note; screenshots", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.article).toBeVisible();
  await wiki.article.getByTestId("wiki-add-note").click();
  await page.getByLabel(/Your note\./u).fill("Never call billing from the web package.");
  await page.screenshot({ path: testInfo.outputPath("wiki-add-note.png"), fullPage: true });
  await page.getByRole("button", { name: "Pin note" }).click();
  const note = wiki.article.getByRole("group", { name: "Note from Priya" }).filter({ hasText: "Never call billing" });
  await expect(note).toContainText("Agents get it after a maintainer approves it.");
  await expect(note.getByTestId("wiki-lesson-offer")).toBeVisible();
  await note.getByRole("button", { name: "Approve for agents" }).click();
  await expect(note).toContainText("Pinned for people and agents.");
  const paragraph = wiki.article.locator('[data-block="p-does-1"]');
  await paragraph.hover();
  await paragraph.getByRole("button", { name: /^Mark wrong/u }).click();
  await page.getByLabel(/What is wrong/u).fill("It moved to charge_v2.ts");
  await page.screenshot({ path: testInfo.outputPath("wiki-mark-wrong.png"), fullPage: true });
  await page.getByTestId("wiki-mark-form").getByRole("button", { name: "Mark wrong" }).click();
  // The paragraph, and the file list that rests on two of the same claims, now read "Marked wrong." beside the one that already did.
  await expect(wiki.article.getByText("Marked wrong.")).toHaveCount(3);
  expect(await violations(page)).toEqual([]);
});

test("corrections: a contributor can add notes and mark wrong but cannot approve and has no disputed list", async ({ page }) => {
  await setFakePerson(page, "sam");
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.article).toBeVisible();
  await expect(wiki.article.getByTestId("wiki-add-note")).toBeVisible();
  await expect(wiki.article.getByRole("button", { name: "Approve for agents" })).toHaveCount(0);
  await expect(page.getByTestId("wiki-disputed-link")).toHaveCount(0);
});

test("corrections: a maintainer opens the disputed list from the navigation", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.article).toBeVisible();
  await page.getByTestId("wiki-disputed-link").click();
  await expect(page.getByTestId("wiki-disputed-empty")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-disputed.png"), fullPage: true });
});
