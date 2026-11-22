import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** Work (boards 2c and 2f): every task as one row of a table on the left, the selected task as a short peek on the right. */
export class WorkPage {
  readonly page: Page;
  readonly root: Locator;
  readonly list: Locator;
  readonly pane: Locator;
  readonly rows: Locator;
  readonly paneTitle: Locator;
  readonly loadError: Locator;
  readonly empty: Locator;
  readonly notConnected: Locator;
  /** The peek's link to the task's own page. */
  readonly fullPage: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("work");
    this.list = page.getByRole("region", { name: "Work list" });
    this.pane = page.getByRole("region", { name: "Selected task" });
    // A row is the table row's own button: a task, or a project's lesson batch.
    this.rows = this.list.locator("button.rv-qp-row");
    this.paneTitle = page.getByTestId("pane-title");
    this.loadError = page.getByTestId("load-error");
    this.empty = page.getByTestId("work-empty");
    this.notConnected = page.getByTestId("not-connected");
    this.fullPage = this.pane.getByRole("link", { name: "Open task", exact: true });
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
  /** The table row of a task, with its status chip (the table has no groups; the chip says who owns the next move). */
  tableRow(title: string): Locator {
    return this.list.getByRole("row").filter({ hasText: title });
  }
  status(title: string, status: string): Locator {
    return this.tableRow(title).getByRole("img", { name: status, exact: true });
  }
  rowByTitle(title: string): Locator {
    return this.rows.filter({ hasText: title });
  }
  /** The decision card: "Your decision" and the other kinds' headings. */
  decision(name = "Your decision"): Locator {
    return this.pane.getByRole("region", { name, exact: true });
  }
  async select(title: string): Promise<void> {
    await this.rowByTitle(title).click();
    await expect(this.paneTitle).toHaveText(title);
  }
}
