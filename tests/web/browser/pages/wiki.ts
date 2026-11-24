import { expect, type Locator, type Page } from "@playwright/test";
import { FAKE_CODE_URL } from "./lessons.js";
import { ROUTES } from "./routes.js";

/** Sets a project's wiki on the pretend Code (Code W2's read routes): `ready` (the default), `none`, `building` or `stopped`; `off` makes Code answer as one with no wiki. */
export async function setWiki(page: Page, project: string, options: { state?: "ready" | "none" | "building" | "stopped"; off?: boolean } = {}): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/wiki`, { data: { project, ...options } });
  expect(answer.status()).toBe(200);
}

/** The project's Wiki pages (G3, rebuilt on the design system): the index with search, one page of section cards, the corrections and Ask views. They draw their own project frame; the "Wiki" pill of its How we work row marks them. */
export class WikiPage {
  readonly page: Page;
  /** The Wiki entry in the project page's own tab list (the way in from the overview). */
  readonly tab: Locator;
  readonly root: Locator;
  /** Kept for the specs that wait for "the page is shown": the whole rebuilt Wiki / Skills surface. */
  readonly article: Locator;
  readonly empty: Locator;
  readonly search: Locator;
  readonly rows: Locator;
  constructor(page: Page) {
    this.page = page;
    this.tab = page.getByRole("tab", { name: "Wiki" });
    this.root = page.locator(".rv-wiki-skills-read");
    this.article = this.root;
    this.empty = this.root.locator(".rv-wsr-line, .rv-wsr-held");
    this.search = page.getByRole("searchbox", { name: "Search the wiki" });
    this.rows = this.root.getByRole("list", { name: "All pages" }).getByRole("listitem");
  }
  async open(project: string, pageId?: string): Promise<void> {
    await this.page.goto(`${ROUTES.project(project)}?tab=wiki${pageId === undefined ? "" : `&page=${pageId}`}`);
  }
  async openView(project: string, view: "disputed" | "gaps" | "setup" | "ask"): Promise<void> {
    await this.page.goto(`${ROUTES.project(project)}?tab=wiki&view=${view}`);
  }
  heading(name: RegExp | string): Locator { return this.root.getByRole("heading", { name }); }
  /** The section card with this title (a level-3 heading inside it). */
  section(title: string): Locator { return this.root.locator(".rv-wsr-card").filter({ has: this.page.getByRole("heading", { level: 3, name: title, exact: true }) }); }
}

/** Sets a project's pretend wiki build on the pretend Code (W0's file map, W4's controls, the nightly upkeep seam). `status` also writes 24 pages; `aiKey` "missing" is a company with no AI key; `off` and `upkeepOff` make Code answer as one without the route; `consent` is the company's consent to automatic runs (off by default), `ceilingOff` the operator's ceiling being off, `legacyUpkeep` a Code with the project switch only. */
export async function setWikiSetup(page: Page, project: string, options: { status?: "built" | "stopped" | "running"; stop?: string; aiKey?: "missing" | "unknown"; mapMade?: boolean; refreshPages?: 0; agentsOn?: boolean; upkeepOn?: boolean; off?: boolean; upkeepOff?: boolean; consent?: boolean; ceilingOff?: boolean; capUsd?: number; legacyUpkeep?: boolean; repair?: { step: string; fixReady: boolean; changed?: string }; paused?: "no_budget" | "monthly_limit" | "cost_too_high"; setupCheckOff?: boolean } = {}): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/wiki-setup`, { data: { project, ...options } });
  expect(answer.status()).toBe(200);
}

/** The wiki panel on the project's Setup tab ("Also for this project", opened with its Open button): the forecast, Build, progress, the report, the switches and nightly upkeep. */
export class WikiSetupPanel {
  readonly page: Page;
  readonly row: Locator;
  constructor(page: Page) {
    this.page = page;
    this.row = page.getByTestId("project-wiki-bare");
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
    await this.page.goto(`${ROUTES.project(project)}?tab=setup`);
    await this.page.getByTestId("also-wiki-open").click();
    await expect(this.row).toBeVisible();
  }
}
