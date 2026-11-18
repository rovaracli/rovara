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

/** Sets a project's pretend wiki build on the pretend Code (W0's file map, W4's controls, the nightly upkeep seam). `status` also writes 24 pages; `aiKey` "missing" is a company with no AI key; `off` and `upkeepOff` make Code answer as one without the route; `consent` is the company's consent to automatic runs (off by default), `ceilingOff` the operator's ceiling being off, `legacyUpkeep` a Code with the project switch only. */
export async function setWikiSetup(page: Page, project: string, options: { status?: "built" | "stopped" | "running"; stop?: string; aiKey?: "missing" | "unknown"; mapMade?: boolean; refreshPages?: 0; agentsOn?: boolean; upkeepOn?: boolean; off?: boolean; upkeepOff?: boolean; consent?: boolean; ceilingOff?: boolean; capUsd?: number; legacyUpkeep?: boolean } = {}): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/wiki-setup`, { data: { project, ...options } });
  expect(answer.status()).toBe(200);
}

/** The wiki row of the project's setup checklist (lead 4 W6): the forecast, Build, progress, the report, the switches and nightly upkeep. */
export class WikiSetupPanel {
  readonly page: Page;
  readonly row: Locator;
  constructor(page: Page) {
    this.page = page;
    this.row = page.getByTestId("checklist-row-wiki");
  }
  byId(id: string): Locator { return this.row.getByTestId(id); }
  get map(): Locator { return this.byId("wiki-setup-map"); }
  get build(): Locator { return this.byId("wiki-setup-build"); }
  get stop(): Locator { return this.byId("wiki-setup-stop"); }
  get continue(): Locator { return this.byId("wiki-setup-continue"); }
  get refresh(): Locator { return this.byId("wiki-setup-refresh"); }
  get agents(): Locator { return this.row.getByRole("switch", { name: "Give the wiki to agents" }); }
  get upkeep(): Locator { return this.row.getByRole("switch", { name: "Nightly upkeep" }); }
  async open(project: string): Promise<void> {
    await this.page.goto(ROUTES.project(project));
    await expect(this.row).toBeVisible();
    if ((await this.row.locator("details").first().getAttribute("open")) === null) await this.row.locator("summary").first().click();
  }
}
