import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";
import { ROUTES } from "./routes.js";

/** Sets a project's wiki on the pretend Code (Code W2's read routes): `ready` (the default), `none`, `building` or `stopped`; `off` makes Code answer as one with no wiki. */
export async function setWiki(page: Page, project: string, options: { state?: "ready" | "none" | "building" | "stopped"; off?: boolean } = {}): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/wiki`, { data: { project, ...options } });
  expect(answer.status()).toBe(200);
}

/** The project's Wiki tab (lead 4 W5): page tree and search on the left, one page in the middle, "On this page" and "About this page" on the right. */
export class WikiPage {
  readonly page: Page;
  readonly tab: Locator;
  readonly wiki: Locator;
  readonly article: Locator;
  readonly empty: Locator;
  readonly results: Locator;
  readonly search: Locator;
  readonly nav: Locator;
  readonly rail: Locator;
  constructor(page: Page) {
    this.page = page;
    this.tab = page.getByRole("tab", { name: "Wiki" });
    this.wiki = page.getByTestId("wiki");
    this.article = page.getByTestId("wiki-page");
    this.empty = page.getByTestId("wiki-empty");
    this.results = page.getByTestId("wiki-results");
    this.search = page.getByRole("searchbox", { name: "Search the wiki" });
    this.nav = page.getByRole("navigation", { name: "Wiki pages" });
    this.rail = page.getByRole("complementary", { name: "About this page" });
  }
  async open(project: string, pageId?: string): Promise<void> {
    await this.page.goto(`${ROUTES.project(project)}?tab=wiki${pageId === undefined ? "" : `&page=${pageId}`}`);
  }
  treeItem(name: RegExp | string): Locator { return this.nav.getByRole("button", { name }); }
  marker(text: RegExp): Locator { return this.article.getByRole("button", { name: text }); }
}
