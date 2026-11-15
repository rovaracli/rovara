import { expect, type Locator, type Page } from "@playwright/test";
import { ROUTES } from "./routes.js";

/** A project's page, where work is started. */
export class ProjectPage {
  readonly page: Page;
  readonly text: Locator;
  readonly start: Locator;
  readonly startError: Locator;
  constructor(page: Page) {
    this.page = page;
    this.text = page.getByTestId("start-work-text");
    this.start = page.getByTestId("start-work-submit");
    this.startError = page.getByTestId("start-work-error");
  }
  async open(project: string): Promise<void> {
    await this.page.goto(ROUTES.project(project));
    await expect(this.text).toBeVisible();
  }
  /** Describe the work and press Start. Opens the task's own page. */
  async startWork(description: string): Promise<void> {
    await this.text.fill(description);
    await expect(this.start).toBeEnabled();
    await this.start.click();
  }
}
