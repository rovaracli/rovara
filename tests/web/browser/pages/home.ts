import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

export class HomePage {
  readonly page: Page;
  readonly root: Locator;
  readonly loadError: Locator;
  /** The decision cards waiting for the person (the plan to approve, the pull request to merge). */
  readonly decisions: Locator;
  readonly empty: Locator;
  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("home");
    this.loadError = page.getByTestId("load-error");
    this.decisions = page.getByRole("list", { name: "Decisions waiting for you" });
    this.empty = page.getByTestId("home-empty");
  }
  async open(): Promise<void> {
    await this.page.goto(ROUTES.home);
  }
  /** Home rendered: it is on screen and did not end in a load error. */
  async expectLoaded(): Promise<void> {
    await expect(this.root).toBeVisible();
    // Home's content, not just its frame: the empty state, the list of things that need the person, or the decision cards waiting for them.
    await expect(this.root.getByTestId("home-empty").or(this.root.getByRole("list", { name: "What needs you" })).or(this.decisions)).toBeVisible();
    await expect(this.root.getByRole("progressbar")).toHaveCount(0);
    await expect(this.loadError).toHaveCount(0);
  }
}
