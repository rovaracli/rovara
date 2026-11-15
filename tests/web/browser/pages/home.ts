import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

export class HomePage {
  readonly page: Page;
  readonly root: Locator;
  readonly loadError: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("home");
    this.loadError = page.getByTestId("load-error");
  }
  async open(): Promise<void> {
    await this.page.goto(ROUTES.home);
  }
  /** Home rendered: it is on screen and did not end in a load error. */
  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible();
    // Home's content, not just its frame: the empty state, or the list of things that need the person.
    await expect(this.root.getByTestId("home-empty").or(this.root.getByRole("list", { name: "What needs you" }))).toBeVisible();
    await expect(this.root.getByRole("progressbar")).toHaveCount(0);
    await expect(this.loadError).toHaveCount(0);
  }
}
