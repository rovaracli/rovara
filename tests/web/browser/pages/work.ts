import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** Work: the split inbox. The list of tasks on the left, the selected task on the right. */
export class WorkPage {
  readonly page: Page;
  readonly root: Locator;
  readonly list: Locator;
  readonly pane: Locator;
  readonly rows: Locator;
  readonly paneTitle: Locator;
  readonly stepRail: Locator;
  readonly loadError: Locator;
  readonly empty: Locator;
  readonly notConnected: Locator;
  /** The link in the pane's head to the task's own page. */
  readonly fullPage: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("work");
    this.list = page.getByRole("region", { name: "Work list" });
    this.pane = page.getByRole("region", { name: "Selected task" });
    this.rows = this.list.locator(".rv-inbox-row");
    this.paneTitle = page.getByTestId("pane-title");
    this.stepRail = page.getByRole("list", { name: "Steps of this task" });
    this.loadError = page.getByTestId("load-error");
    this.empty = page.getByTestId("work-empty");
    this.notConnected = page.getByTestId("not-connected");
    this.fullPage = page.getByRole("link", { name: /^Open the full page/u });
  }
  async open(task?: string): Promise<void> {
    await this.page.goto(task === undefined ? ROUTES.work : `${ROUTES.work}?task=${task}`);
  }
  /** Work loaded: the list has rows and the pane shows a task, with no error and nothing still loading. */
  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.rows.first()).toBeVisible();
    await expect(this.paneTitle).toBeVisible();
    await expect(this.loadError).toHaveCount(0);
    await expect(this.list.getByRole("progressbar")).toHaveCount(0);
  }
  group(name: string): Locator {
    return this.list.getByRole("region", { name, exact: true });
  }
  rowByTitle(title: string): Locator {
    return this.rows.filter({ hasText: title });
  }
  /** The decision card: "Your decision" and the other kinds' headings. */
  decision(name = "Your decision"): Locator {
    return this.pane.getByRole("region", { name, exact: true });
  }
  step(label: string): Locator {
    return this.stepRail.getByRole("button", { name: new RegExp(`^${label}`, "u") });
  }
  async select(title: string): Promise<void> {
    await this.rowByTitle(title).click();
    await expect(this.paneTitle).toHaveText(title);
  }
}
