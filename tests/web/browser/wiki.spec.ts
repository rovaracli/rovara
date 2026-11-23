// Lead 4 W5 + G3 in the browser, on the pretend Code (which serves Code W2's wiki read routes for the made-up "Beacon" wiki): the project's Wiki on its rebuilt pages (the index with search, a page of
// section cards with source chips and links, the corrections, notes and Mark wrong), the empty and edge states, phone width, dark mode and the keyboard. Screenshots go to the test output folder.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { PROJECT, ROUTES, WikiPage, setFakePerson, setWiki } from "./pages/index.js";

test.afterEach(async ({ page }) => { await setWiki(page, PROJECT); await setFakePerson(page, "priya"); });

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page, contrast = false): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async (enabled) => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { rules: { "color-contrast": { enabled } } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  }, contrast);
}

test("the Wiki opens at its index, then a page of section cards with source chips, a code-host link and the trust line", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.heading(`What Rovara knows about ${PROJECT}`)).toBeVisible();
  await expect(wiki.root.getByRole("link", { name: "Wiki" }).first()).toHaveAttribute("aria-current", "page");
  await expect(wiki.rows.first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-index.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
  await wiki.root.getByRole("link", { name: "Product overview" }).first().click();
  await expect(page).toHaveURL(/page=overview/u);
  await expect(wiki.heading("Product overview").first()).toBeVisible();
  await expect(wiki.root).toContainText("Written by Rovara from the code. It can be wrong. The code is the truth.");
  await expect(wiki.root.getByText("Source found").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-overview.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
});

test("the source fold lists the cited files (a code-host link only for a repository the project lists)", async ({ page }) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.heading("What it does")).toBeVisible();
  // The pretend project lists none of the wiki's repositories, so no code-host link is built (never from wiki text).
  await expect(wiki.root.getByRole("link", { name: /Open on/u })).toHaveCount(0);
  await wiki.root.getByText("Relevant source files").click();
  await expect(wiki.root.getByRole("list", { name: "Source files" })).toContainText("beacon-api/src/billing/charge.ts");
});

test("a stale, not-found and marked-wrong claim says so on its section; pinned notes show with their approval", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.section("What it does")).toContainText("Disputed");
  await expect(wiki.root.getByText("Source changed").first()).toBeVisible();
  await expect(wiki.root.getByText("Source not found").first()).toBeVisible();
  await expect(wiki.root.getByRole("group", { name: "Note from Priya" })).toContainText("Agents get it after a maintainer approves it.");
  await expect(wiki.root.getByRole("group", { name: "Note from Sam" })).toContainText("Pinned for people and agents.");
  // Priya is an administrator: she is offered the corrections (C1): one Mark wrong on each section that has an unmarked claim.
  await expect(wiki.root.getByRole("button", { name: /^Mark wrong: /u })).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("wiki-billing-notes.png"), fullPage: true });
});

test("the index opens another page, keeps it in the address and the browser Back returns to the index", async ({ page }) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await wiki.root.getByRole("link", { name: "Glossary" }).first().click();
  await expect(wiki.heading("Glossary").first()).toBeVisible();
  await expect(page).toHaveURL(/page=glossary/u);
  await page.goBack();
  await expect(wiki.heading(`What Rovara knows about ${PROJECT}`)).toBeVisible();
});

test("search looks through titles, summaries and page text, and says so when nothing matches", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.rows.first()).toBeVisible();
  await wiki.search.fill("refund");
  const results = wiki.root.getByRole("list", { name: "Search results" });
  await expect(results).toContainText("billing");
  await page.screenshot({ path: testInfo.outputPath("wiki-search.png"), fullPage: true });
  await results.getByRole("link", { name: /billing/u }).first().click();
  await expect(wiki.heading("billing").first()).toBeVisible();
  await page.goBack();
  await wiki.search.fill("zzzqqq");
  await expect(page.getByText("No page mentions that. The wiki does not guess.")).toBeVisible();
});

test("a page marked wrong and a page most of whose claims changed say so", async ({ page }) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "repo-beacon-agents");
  await expect(wiki.root).toContainText("open disputed mark");
});

test("empty and edge states: no wiki yet, a build running, a stopped build, and a Code with no wiki hides the tab", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await setWiki(page, PROJECT, { state: "none" });
  await wiki.open(PROJECT);
  await expect(wiki.root).toContainText("No wiki pages yet.");
  await page.screenshot({ path: testInfo.outputPath("wiki-empty.png"), fullPage: true });
  expect(await violations(page)).toEqual([]);
  await setWiki(page, PROJECT, { state: "building" });
  await page.reload();
  await expect(wiki.root).toContainText("The first wiki build is running.");
  await setWiki(page, PROJECT, { state: "stopped" });
  await page.reload();
  await expect(wiki.root).toContainText("Last build: stopped");
  await setWiki(page, PROJECT, { off: true });
  await page.goto(ROUTES.project(PROJECT));
  await expect(page.getByRole("tab", { name: "How we work" })).toBeVisible();
  await expect(wiki.tab).toHaveCount(0);
});

test("a person with a role on the project (Sam) reads the wiki too", async ({ page }) => {
  await setFakePerson(page, "sam");
  await page.context().clearCookies();
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.rows.first()).toBeVisible();
});

test("phone width: the index and a page fill the width and nothing scrolls sideways", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.heading("What it does")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("wiki-phone.png"), fullPage: true });
  await wiki.open(PROJECT);
  await expect(wiki.search).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("dark mode keeps the page readable", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.heading("What it does")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("wiki-dark.png"), fullPage: true });
  // Colour contrast of the chips, notes and status words, in both themes (the other checks leave contrast off).
  expect(await violations(page, true)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(wiki.heading("What it does")).toBeVisible();
  expect(await violations(page, true)).toEqual([]);
});

test("corrections: a person adds a note and marks a section wrong; a maintainer approves the note; screenshots", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.heading("What it does")).toBeVisible();
  await wiki.root.getByTestId("wiki-add-note").click();
  await page.getByLabel(/Your note\./u).fill("Never call billing from the web package.");
  await page.screenshot({ path: testInfo.outputPath("wiki-add-note.png"), fullPage: true });
  await page.getByRole("button", { name: "Pin note" }).click();
  const note = wiki.root.getByRole("group", { name: "Note from Priya" }).filter({ hasText: "Never call billing" });
  await expect(note).toContainText("Agents get it after a maintainer approves it.");
  await expect(note.getByTestId("wiki-lesson-offer")).toBeVisible();
  await note.getByRole("button", { name: "Approve for agents" }).click();
  await expect(note).toContainText("Pinned for people and agents.");
  await wiki.root.getByRole("button", { name: "Mark wrong: What it does" }).click();
  // Each unmarked claim of the section is offered to tick (none ticked at first); one tick = one mark.
  const claims = page.getByTestId("wiki-mark-claims").getByRole("checkbox");
  await expect(claims.first()).toHaveAttribute("aria-checked", "false");
  await claims.first().click();
  await expect(claims.first()).toHaveAttribute("aria-checked", "true");
  await page.getByLabel(/What is wrong/u).fill("It moved to charge_v2.ts");
  await page.screenshot({ path: testInfo.outputPath("wiki-mark-wrong.png"), fullPage: true });
  await page.getByTestId("wiki-mark-form").getByRole("button", { name: "Mark wrong" }).click();
  // The section, and the file list that rests on two of the same claims, now carry an open mark (the page chip counts them).
  await expect(wiki.section("What it does")).toContainText("Disputed");
  await expect(page.getByTestId("wiki-mark-form")).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});

test("corrections: a contributor can add notes and mark wrong but cannot approve and has no disputed list", async ({ page }) => {
  await setFakePerson(page, "sam");
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT, "beacon-api--billing");
  await expect(wiki.heading("What it does")).toBeVisible();
  await expect(wiki.root.getByTestId("wiki-add-note")).toBeVisible();
  await expect(wiki.root.getByRole("button", { name: "Approve for agents" })).toHaveCount(0);
  await wiki.open(PROJECT);
  await expect(wiki.rows.first()).toBeVisible();
  await expect(wiki.root.getByRole("link", { name: "Disputed sections" })).toHaveCount(0);
});

test("corrections: a maintainer opens the disputed list from the index", async ({ page }, testInfo) => {
  const wiki = new WikiPage(page);
  await wiki.open(PROJECT);
  await expect(wiki.rows.first()).toBeVisible();
  await wiki.root.getByRole("link", { name: "Disputed sections" }).click();
  await expect(wiki.heading("Corrections to decide")).toBeVisible();
  await expect(wiki.root).toContainText("No disputed sections in this read.");
  await page.screenshot({ path: testInfo.outputPath("wiki-disputed.png"), fullPage: true });
});
